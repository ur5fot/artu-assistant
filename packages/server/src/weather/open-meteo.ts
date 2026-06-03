// Open-Meteo client: forecast + geocoding + WMO→RU mapping + brief outlook.
//
// Open-Meteo is free, key-less, and exposes a single JSON endpoint per
// location — far more robust than scraping a dozen searxng engines. On any
// network/HTTP failure these functions throw; callers degrade gracefully
// (brief → "погода недоступна", tool → error, alert → skip).

import type {
  DayForecast,
  Forecast,
  GeocodeResult,
  HourForecast,
} from './types.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 8000;

/** WMO weather interpretation codes → short Russian description. */
export const WMO_RU: Record<number, string> = {
  0: 'ясно',
  1: 'преимущественно ясно',
  2: 'переменная облачность',
  3: 'пасмурно',
  45: 'туман',
  48: 'изморозь',
  51: 'слабая морось',
  53: 'морось',
  55: 'сильная морось',
  56: 'ледяная морось',
  57: 'сильная ледяная морось',
  61: 'слабый дождь',
  63: 'дождь',
  65: 'сильный дождь',
  66: 'ледяной дождь',
  67: 'сильный ледяной дождь',
  71: 'слабый снег',
  73: 'снег',
  75: 'сильный снег',
  77: 'снежная крупа',
  80: 'слабый ливень',
  81: 'ливень',
  82: 'сильный ливень',
  85: 'снежный ливень',
  86: 'сильный снежный ливень',
  95: 'гроза',
  96: 'гроза с градом',
  99: 'сильная гроза с градом',
};

/** Human-readable RU description for a WMO code (fallback for unknown codes). */
export function wmoToRu(code: number): string {
  return WMO_RU[code] ?? `код ${code}`;
}

interface ForecastResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: Array<number | null>;
    weathercode?: number[];
    wind_speed_10m_max?: number[];
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: Array<number | null>;
    weathercode?: number[];
  };
}

/**
 * Fetch a `days`-day forecast for the given coordinates.
 * Throws on timeout / non-2xx / malformed payload.
 */
export async function fetchForecast(
  lat: number,
  lon: number,
  tz: string,
  days = 3,
): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: tz,
    forecast_days: String(days),
    daily:
      'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,wind_speed_10m_max',
    hourly: 'temperature_2m,precipitation_probability,weathercode',
  });

  const res = await fetch(`${FORECAST_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo forecast error: ${res.status}`);
  }
  const data = (await res.json()) as ForecastResponse;
  return parseForecast(lat, lon, tz, data);
}

function parseForecast(
  lat: number,
  lon: number,
  tz: string,
  data: ForecastResponse,
): Forecast {
  const d = data.daily;
  if (!d || !d.time) {
    throw new Error('Open-Meteo forecast: missing daily block');
  }
  const days: DayForecast[] = d.time.map((date, i) => ({
    date,
    tempMax: temp(d.temperature_2m_max?.[i]),
    tempMin: temp(d.temperature_2m_min?.[i]),
    precipProbMax: num(d.precipitation_probability_max?.[i]),
    weatherCode: num(d.weathercode?.[i]),
    windMax: num(d.wind_speed_10m_max?.[i]),
  }));

  const h = data.hourly;
  const hours: HourForecast[] = (h?.time ?? []).map((time, i) => ({
    time,
    temp: num(h?.temperature_2m?.[i]),
    precipProb: num(h?.precipitation_probability?.[i]),
    weatherCode: num(h?.weathercode?.[i]),
  }));

  return { lat, lon, tz, days, hours };
}

/** Coerce a possibly-null/undefined numeric field to a finite number (0 fallback). */
function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Temperature coercion: missing/non-finite → `NaN`, never a fabricated `0`.
 * A real `0` would otherwise satisfy frost detection (`tempMin <= 0`) and fire a
 * spurious alert on a partial payload. `NaN` fails every comparison instead, so
 * detection and the brief outlook skip it safely.
 */
function temp(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

interface GeocodeResponse {
  results?: Array<{
    latitude: number;
    longitude: number;
    name: string;
    admin1?: string;
  }>;
}

/**
 * Geocode a place name via Open-Meteo. Returns the top match or `null` when
 * nothing is found. Throws on timeout / non-2xx.
 *
 * `opts.country` (ISO-2) biases results to one country — used to disambiguate
 * the user's small home village. Omit it (the on-demand `weather` tool does) to
 * resolve any city worldwide.
 */
export async function geocode(
  name: string,
  opts: { country?: string; lang?: string } = {},
): Promise<GeocodeResult | null> {
  const { country, lang = 'ru' } = opts;
  const params = new URLSearchParams({
    name,
    count: '1',
    language: lang,
    format: 'json',
  });
  if (country) params.set('countryCode', country);

  const res = await fetch(`${GEOCODE_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo geocoding error: ${res.status}`);
  }
  const data = (await res.json()) as GeocodeResponse;
  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    name: hit.name,
    admin1: hit.admin1 ?? '',
  };
}

const DAY_LABELS = ['Сегодня', 'Завтра', 'Послезавтра'];

/** Short Russian 3-day overview built from the daily block. */
export function formatBriefOutlook(forecast: Forecast): string {
  if (forecast.days.length === 0) return 'погода недоступна';
  return forecast.days
    .map((day, i) => {
      const label = DAY_LABELS[i] ?? day.date;
      const lo = Math.round(day.tempMin);
      const hi = Math.round(day.tempMax);
      const temps =
        Number.isFinite(lo) && Number.isFinite(hi) ? `${lo}–${hi}°` : 'темп. н/д';
      let line = `${label}: ${wmoToRu(day.weatherCode)}, ${temps}`;
      if (day.precipProbMax >= 50) {
        line += ` (осадки ${day.precipProbMax}%)`;
      }
      return line;
    })
    .join('\n');
}
