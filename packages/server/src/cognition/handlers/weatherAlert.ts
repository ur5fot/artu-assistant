// Proactive weather-change alert handler.
//
// `trigger` is cheap (no network): throttle since last check + not in quiet
// hours + coords known. `run` is the expensive path: fetch the forecast, run
// the pure `detectWeatherChanges`, and publish each *new* event that falls in
// its lead window exactly once. Dedup lives in `weather_alerts` (per-event
// key); the last-check timestamp throttles the whole handler.
//
// Lead window (spec §5): an intraday event fires when it is within `leadHours`;
// a next-day event is pre-announced the evening before — never midday or
// overnight (quiet hours already hold the overnight window).

import type { Handler, HandlerResult } from '../types.js';
import type { WeatherAlertStore } from '../../weather/alert-store.js';
import type { Coords, Forecast } from '../../weather/types.js';
import {
  detectWeatherChanges,
  type DetectThresholds,
  type WeatherEvent,
  type WeatherEventType,
} from '../../weather/detect.js';
import { fetchForecast } from '../../weather/open-meteo.js';
import { inQuietHours } from './emailDigest.helpers.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Earliest local hour at which a next-day event may be pre-announced. Below
// this we wait — a brief already covers the morning, so daytime is noise.
const EVENING_HOUR = 18;

/** Emoji prefix per event type (RU alert text comes from `detectWeatherChanges`). */
const EMOJI: Record<WeatherEventType, string> = {
  'temp-swing': '🌡️',
  precip: '🌧',
  frost: '🥶',
  storm: '⚠️',
};

/** Fetch a forecast for the given coordinates (injected; defaults to real client). */
export type ForecastFn = (lat: number, lon: number, tz: string) => Promise<Forecast>;
/** Detect weather changes (injected; defaults to the pure `detectWeatherChanges`). */
export type DetectFn = (
  forecast: Forecast,
  now: number,
  thresholds: DetectThresholds,
) => WeatherEvent[];

export interface WeatherAlertDeps {
  store: WeatherAlertStore;
  /** Resolved user coordinates, or null when geocoding failed (handler is inert). */
  coords: Coords | null;
  tz: string;
  /** Minimum hours between forecast checks (cheap throttle in `trigger`). */
  checkIntervalH: number;
  /** Suppress re-pinging the same event key within this many hours. */
  dedupeH: number;
  /** Look-ahead window for intraday events (hours). */
  leadHours: number;
  /** Quiet-hours bounds (local hour): no pings at `>= quietStart` or `< quietEnd`. */
  quietStart: number;
  quietEnd: number;
  /** Detection thresholds forwarded to `detectWeatherChanges`. */
  thresholds?: DetectThresholds;
  /** Injectable forecast fetch (tests); defaults to the real Open-Meteo client. */
  fetchForecast?: ForecastFn;
  /** Injectable detector (tests); defaults to the pure `detectWeatherChanges`. */
  detect?: DetectFn;
}

export function createWeatherAlertHandler(deps: WeatherAlertDeps): Handler {
  const fetch: ForecastFn = deps.fetchForecast ?? ((lat, lon, tz) => fetchForecast(lat, lon, tz));
  const detect: DetectFn = deps.detect ?? detectWeatherChanges;

  return {
    name: 'weatherAlert',

    trigger(state) {
      if (!deps.coords) return false;
      if (inQuietHours(state.now, deps.quietStart, deps.tz, deps.quietEnd)) return false;
      const last = deps.store.lastCheckAt();
      if (last !== null && state.now - last < deps.checkIntervalH * HOUR_MS) return false;
      return true;
    },

    async run(ctx): Promise<HandlerResult> {
      const coords = deps.coords;
      if (!coords) return { skip: true, reason: 'no coords' };

      // Advance the throttle for both success and failure so a transient
      // Open-Meteo outage retries on the next interval, not every tick.
      deps.store.setLastCheckAt(ctx.firedAt);

      let forecast: Forecast;
      try {
        forecast = await fetch(coords.lat, coords.lon, deps.tz);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { skip: true, reason: `fetch failed: ${message}` };
      }

      // `leadHours` is the single source of truth (deps.leadHours): forward it
      // into the detector's look-ahead so the two paths can't silently drift.
      const events = detect(forecast, ctx.firedAt, { ...deps.thresholds, leadHours: deps.leadHours });
      const dedupeSince = ctx.firedAt - deps.dedupeH * HOUR_MS;
      const fresh = events.filter(
        (e) =>
          withinLeadWindow(e.when, ctx.firedAt, deps.tz, deps.leadHours) &&
          deps.store.findRecentAlert(e.key, dedupeSince) === null,
      );

      if (fresh.length === 0) {
        return { skip: true, reason: events.length ? 'no fresh events in lead window' : 'no events' };
      }

      const content = fresh.map((e) => `${EMOJI[e.type]} ${e.message}`).join('\n');
      return {
        publish: true,
        content,
        onPublished: () => {
          for (const e of fresh) deps.store.recordAlert(e.key, ctx.firedAt);
        },
      };
    },
  };
}

/**
 * Whether an event at `when` should be alerted now, given its calendar-day
 * distance from `now` (spec §5 lead-time):
 * - today (same local day): only if upcoming within `leadHours`;
 * - tomorrow: only in the evening before (`hour >= EVENING_HOUR`);
 * - further out / already past: not yet.
 */
function withinLeadWindow(when: number, now: number, tz: string, leadHours: number): boolean {
  const daysAhead = localDayDiff(now, when, tz);
  if (daysAhead < 0) return false;
  if (daysAhead === 0) {
    return when > now && when - now <= leadHours * HOUR_MS;
  }
  if (daysAhead === 1) {
    return localParts(now, tz).hour >= EVENING_HOUR;
  }
  return false;
}

/** Calendar-day difference (`when` − `now`) in `tz`. */
function localDayDiff(now: number, when: number, tz: string): number {
  const a = localParts(now, tz);
  const b = localParts(when, tz);
  const da = Date.UTC(a.year, a.month - 1, a.day);
  const db = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((db - da) / DAY_MS);
}

function localParts(
  epochMs: number,
  tz: string,
): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) map[p.type] = p.value;
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour };
}
