// Pure detection of abrupt weather changes from a parsed Forecast.
//
// `detectWeatherChanges` is deterministic: `now` and `forecast` are inputs, no
// clock/network. It returns the set of notable events the proactive
// `weatherAlert` handler may publish; dedup/throttle/quiet-hours live in the
// handler. Each event carries a stable `key` (type + date) so the same event is
// only ever pinged once.

import { wmoToRu } from './open-meteo.js';
import type { Forecast, HourForecast } from './types.js';

/** Categories of abrupt change we surface proactively. */
export type WeatherEventType = 'temp-swing' | 'precip' | 'frost' | 'storm';

/** A single detected weather change. */
export interface WeatherEvent {
  type: WeatherEventType;
  /** Epoch ms (forecast-local wall time resolved to UTC) when the event occurs. */
  when: number;
  /** Stable dedup key: `type+YYYY-MM-DD`. */
  key: string;
  /** Russian one-line alert text. */
  message: string;
}

/** Tunable detection thresholds (env-backed in the handler). */
export interface DetectThresholds {
  /** Min |Δ tempMax| today→tomorrow to flag a temperature swing (°C). */
  tempSwingC?: number;
  /** Min precipitation probability to count as "rain coming" (%). */
  precipProbPct?: number;
  /** Look-ahead window for intraday precipitation (hours). */
  leadHours?: number;
  /** Min daily max wind to flag a wind event (km/h). */
  windMaxKmh?: number;
}

const DEFAULTS: Required<DetectThresholds> = {
  tempSwingC: 8,
  precipProbPct: 60,
  leadHours: 6,
  windMaxKmh: 50,
};

/** WMO codes that count as a thunderstorm. */
const THUNDER = new Set([95, 96, 99]);

const HOUR_MS = 3600_000;

/**
 * Detect abrupt weather changes ahead. Pure: same inputs → same output.
 *
 * @param forecast parsed Open-Meteo forecast (days + hours, local times in `tz`)
 * @param now epoch ms "now"
 * @param thresholds detection knobs (defaults applied per-field)
 */
export function detectWeatherChanges(
  forecast: Forecast,
  now: number,
  thresholds: DetectThresholds = {},
): WeatherEvent[] {
  const { tempSwingC, precipProbPct, leadHours, windMaxKmh } = {
    ...DEFAULTS,
    ...thresholds,
  };
  const { tz, days, hours } = forecast;
  const events: WeatherEvent[] = [];

  // 1. Temperature swing today → tomorrow.
  if (days.length >= 2) {
    const delta = days[1].tempMax - days[0].tempMax;
    if (Math.abs(delta) >= tempSwingC) {
      const dir = delta < 0 ? 'холоднее' : 'теплее';
      events.push({
        type: 'temp-swing',
        when: dayStart(days[1].date, tz),
        key: `temp-swing+${days[1].date}`,
        message: `Завтра резко ${dir}: ${Math.round(days[0].tempMax)}° → ${Math.round(
          days[1].tempMax,
        )}° (Δ${Math.round(Math.abs(delta))}°)`,
      });
    }
  }

  // 2. Rain coming — prefer an intraday hourly hit in the lead window, else
  //    fall back to a wet next-day daily forecast.
  const intraday = detectIntradayPrecip(hours, now, tz, leadHours, precipProbPct);
  if (intraday) {
    events.push(intraday);
  } else if (days.length >= 2 && days[1].precipProbMax >= precipProbPct) {
    events.push({
      type: 'precip',
      when: dayStart(days[1].date, tz),
      key: `precip+${days[1].date}`,
      message: `Завтра осадки (${wmoToRu(days[1].weatherCode)}, вероятность ${
        days[1].precipProbMax
      }%)`,
    });
  }

  // 3. Frost — every upcoming day dropping to/below 0°. Emit one event per
  //    qualifying day (not just the earliest): the handler's lead window picks
  //    the day to ping, so a frost already in progress today must not shadow
  //    tomorrow's pre-announce. NaN tempMin (partial payload) never satisfies.
  for (const frostDay of days.filter((d) => d.tempMin <= 0)) {
    events.push({
      type: 'frost',
      when: dayStart(frostDay.date, tz),
      key: `frost+${frostDay.date}`,
      message: `Заморозок: ${frostDay.date} ночью до ${Math.round(frostDay.tempMin)}°`,
    });
  }

  // 4. Thunderstorm / strong wind — every qualifying day, for the same reason as
  //    frost: an in-progress storm today must not mask tomorrow's.
  for (const stormDay of days.filter(
    (d) => THUNDER.has(d.weatherCode) || d.windMax >= windMaxKmh,
  )) {
    const thunder = THUNDER.has(stormDay.weatherCode);
    events.push({
      type: 'storm',
      when: dayStart(stormDay.date, tz),
      key: `storm+${stormDay.date}`,
      message: thunder
        ? `Гроза: ${stormDay.date} (${wmoToRu(stormDay.weatherCode)})`
        : `Сильный ветер: ${stormDay.date}, до ${Math.round(stormDay.windMax)} км/ч`,
    });
  }

  return events;
}

/**
 * Intraday "rain coming" detection: dry at/just before `now`, then a wet hour
 * (`precipProb ≥ pct`) within the next `leadHours`. Returns null otherwise.
 */
function detectIntradayPrecip(
  hours: HourForecast[],
  now: number,
  tz: string,
  leadHours: number,
  pct: number,
): WeatherEvent | null {
  if (hours.length === 0) return null;
  const windowEnd = now + leadHours * HOUR_MS;

  let currentDry = true;
  let firstWet: { hour: HourForecast; at: number } | null = null;
  for (const h of hours) {
    const at = parseZoned(h.time, tz);
    if (at <= now) {
      // Latest hour at/before now defines current conditions.
      currentDry = h.precipProb < pct;
      continue;
    }
    if (at > windowEnd) break;
    if (h.precipProb >= pct) {
      firstWet = { hour: h, at };
      break;
    }
  }
  if (!currentDry || !firstWet) return null;

  const inHours = Math.max(1, Math.round((firstWet.at - now) / HOUR_MS));
  const date = firstWet.hour.time.slice(0, 10);
  return {
    type: 'precip',
    when: firstWet.at,
    key: `precip+${date}`,
    message: `Через ~${inHours}ч осадки (${wmoToRu(firstWet.hour.weatherCode)}, ${
      firstWet.hour.precipProb
    }%)`,
  };
}

/** Epoch ms for the start of a local calendar day (`YYYY-MM-DD`) in `tz`. */
function dayStart(date: string, tz: string): number {
  return parseZoned(`${date}T00:00`, tz);
}

/**
 * Resolve a local wall-clock string (`YYYY-MM-DDTHH:mm`, no offset) in `tz` to
 * epoch ms. Uses the standard "format-back" trick to find the zone offset.
 */
function parseZoned(local: string, tz: string): number {
  const [datePart, timePart] = local.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  return asUtc - tzOffsetMs(asUtc, tz);
}

/** Offset (ms) of `tz` at the given UTC instant: tz wall time − UTC. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // 'hour' can be '24' at midnight in some engines; normalize to 0.
  const hour = map.hour === 24 ? 0 : map.hour;
  const asWall = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asWall - utcMs;
}
