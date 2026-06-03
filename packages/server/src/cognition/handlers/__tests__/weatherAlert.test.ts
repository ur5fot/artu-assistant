import { describe, it, expect } from 'vitest';
import { createWeatherAlertHandler, type WeatherAlertDeps } from '../weatherAlert.js';
import type { WeatherAlertStore, WeatherAlertRow } from '../../../weather/alert-store.js';
import type { Coords, Forecast } from '../../../weather/types.js';
import type { WeatherEvent } from '../../../weather/detect.js';

const HOUR = 3_600_000;
// 2026-06-04, Europe/Kyiv is UTC+3 (EEST) → Kyiv local = UTC + 3.
const NOON = Date.UTC(2026, 5, 4, 9, 0, 0); // 12:00 Kyiv
const NIGHT = Date.UTC(2026, 5, 4, 20, 0, 0); // 23:00 Kyiv (quiet)

const COORDS: Coords = { city: 'Kalynivka', lat: 49.5, lon: 36.8 };
const FORECAST: Forecast = { lat: 49.5, lon: 36.8, tz: 'Europe/Kyiv', days: [], hours: [] };

function fakeStore(): WeatherAlertStore & { alerts: Array<{ key: string; at: number }> } {
  const alerts: Array<{ key: string; at: number }> = [];
  let lastCheck: number | null = null;
  return {
    alerts,
    recordAlert(key, at) {
      alerts.push({ key, at });
      return alerts.length;
    },
    findRecentAlert(key, since): WeatherAlertRow | null {
      const hit = alerts
        .filter((a) => a.key === key && a.at >= since)
        .sort((x, y) => y.at - x.at)[0];
      return hit ? { id: 1, event_key: hit.key, alerted_at: hit.at } : null;
    },
    lastCheckAt() {
      return lastCheck;
    },
    setLastCheckAt(at) {
      lastCheck = at;
    },
  };
}

function baseDeps(over: Partial<WeatherAlertDeps> = {}): WeatherAlertDeps {
  return {
    store: fakeStore(),
    coords: COORDS,
    tz: 'Europe/Kyiv',
    checkIntervalH: 3,
    dedupeH: 12,
    leadHours: 6,
    quietStart: 22,
    quietEnd: 8,
    fetchForecast: async () => FORECAST,
    detect: () => [],
    ...over,
  };
}

function intradayEvent(now: number): WeatherEvent {
  return {
    type: 'precip',
    when: now + 2 * HOUR,
    key: 'precip+2026-06-04',
    message: 'Через ~2ч осадки (дождь, 80%)',
  };
}

// Frost dated tomorrow (2026-06-05 00:00 Kyiv = 2026-06-04T21:00Z), relative to
// a same-day (2026-06-04) `now` → daysAhead === 1, the evening pre-announce branch.
function tomorrowEvent(): WeatherEvent {
  return {
    type: 'frost',
    when: Date.UTC(2026, 5, 4, 21, 0),
    key: 'frost+2026-06-05',
    message: 'Заморозок: 2026-06-05 ночью до -2°',
  };
}

const ctx = (firedAt: number) => ({ firedAt }) as never;

describe('createWeatherAlertHandler', () => {
  describe('trigger', () => {
    it('returns false when coords are missing', async () => {
      const h = createWeatherAlertHandler(baseDeps({ coords: null }));
      expect(await h.trigger({ now: NOON, lastFiredAt: null, lastResult: null }, {} as never)).toBe(
        false,
      );
    });

    it('returns false during quiet hours', async () => {
      const h = createWeatherAlertHandler(baseDeps());
      expect(await h.trigger({ now: NIGHT, lastFiredAt: null, lastResult: null }, {} as never)).toBe(
        false,
      );
    });

    it('returns false when the last check is within the throttle interval', async () => {
      const store = fakeStore();
      store.setLastCheckAt(NOON - HOUR); // 1h ago < 3h interval
      const h = createWeatherAlertHandler(baseDeps({ store }));
      expect(await h.trigger({ now: NOON, lastFiredAt: null, lastResult: null }, {} as never)).toBe(
        false,
      );
    });

    it('returns true when coords present, awake, and throttle elapsed', async () => {
      const store = fakeStore();
      store.setLastCheckAt(NOON - 4 * HOUR); // 4h ago > 3h interval
      const h = createWeatherAlertHandler(baseDeps({ store }));
      expect(await h.trigger({ now: NOON, lastFiredAt: null, lastResult: null }, {} as never)).toBe(
        true,
      );
    });
  });

  describe('run', () => {
    it('publishes a new event once and records it on publish', async () => {
      const store = fakeStore();
      const h = createWeatherAlertHandler(
        baseDeps({ store, detect: (_f, now) => [intradayEvent(now)] }),
      );
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ publish: true });
      if (!('publish' in res)) throw new Error('expected publish');
      expect(res.content).toBe('🌧 Через ~2ч осадки (дождь, 80%)');

      expect(store.alerts).toHaveLength(0); // not recorded until delivery confirmed
      await res.onPublished?.();
      expect(store.alerts).toEqual([{ key: 'precip+2026-06-04', at: NOON }]);
      expect(store.lastCheckAt()).toBe(NOON);
    });

    it('dedupes an event already alerted within the dedupe window', async () => {
      const store = fakeStore();
      store.recordAlert('precip+2026-06-04', NOON - 2 * HOUR); // within 12h dedupe
      const h = createWeatherAlertHandler(
        baseDeps({ store, detect: (_f, now) => [intradayEvent(now)] }),
      );
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ skip: true });
    });

    it('re-alerts once the dedupe window has passed', async () => {
      const store = fakeStore();
      store.recordAlert('precip+2026-06-04', NOON - 13 * HOUR); // older than 12h dedupe
      const h = createWeatherAlertHandler(
        baseDeps({ store, detect: (_f, now) => [intradayEvent(now)] }),
      );
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ publish: true });
    });

    it('pre-announces a tomorrow event in the evening (hour >= 18)', async () => {
      const store = fakeStore();
      const evening = Date.UTC(2026, 5, 4, 16, 0); // 19:00 Kyiv, awake
      const h = createWeatherAlertHandler(
        baseDeps({ store, detect: () => [tomorrowEvent()] }),
      );
      const res = await h.run(ctx(evening));
      expect(res).toMatchObject({ publish: true });
      if (!('publish' in res)) throw new Error('expected publish');
      expect(res.content).toBe('🥶 Заморозок: 2026-06-05 ночью до -2°');
    });

    it('holds a tomorrow event before the evening window (hour < 18)', async () => {
      const store = fakeStore();
      // NOON is 12:00 Kyiv on 2026-06-04 → daysAhead 1 but before EVENING_HOUR.
      const h = createWeatherAlertHandler(
        baseDeps({ store, detect: () => [tomorrowEvent()] }),
      );
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ skip: true });
      expect(store.alerts).toHaveLength(0);
    });

    it('skips events outside the lead window', async () => {
      const store = fakeStore();
      const farEvent: WeatherEvent = {
        type: 'frost',
        when: NOON + 3 * 24 * HOUR, // 3 days out → not yet
        key: 'frost+2026-06-07',
        message: 'Заморозок',
      };
      const h = createWeatherAlertHandler(baseDeps({ store, detect: () => [farEvent] }));
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ skip: true });
      expect(store.alerts).toHaveLength(0);
    });

    it('skips and advances the throttle when the fetch fails', async () => {
      const store = fakeStore();
      const h = createWeatherAlertHandler(
        baseDeps({
          store,
          fetchForecast: async () => {
            throw new Error('timeout');
          },
        }),
      );
      const res = await h.run(ctx(NOON));
      expect(res).toMatchObject({ skip: true });
      if ('skip' in res) expect(res.reason).toContain('fetch failed');
      expect(store.lastCheckAt()).toBe(NOON); // throttle advanced despite failure
    });
  });
});
