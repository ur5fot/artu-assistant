// These shapes mirror packages/server/src/weather/types.ts and the Open-Meteo
// client surface. Duplicated locally to keep @r2/tool-weather self-contained
// (no cross-package relative imports). TypeScript's structural typing means the
// real server types/client satisfy these. If these drift, lift them into
// @r2/shared.

/** One day of the daily forecast (Open-Meteo `daily` block). */
export interface DayForecast {
  /** Local calendar date `YYYY-MM-DD`. */
  date: string;
  tempMax: number;
  tempMin: number;
  /** Max precipitation probability for the day, 0–100. */
  precipProbMax: number;
  /** WMO weather code (worst/representative for the day). */
  weatherCode: number;
  /** Max wind speed for the day (km/h). */
  windMax: number;
}

/** One hour of the hourly forecast (Open-Meteo `hourly` block). */
export interface HourForecast {
  /** Local timestamp `YYYY-MM-DDTHH:mm`. */
  time: string;
  temp: number;
  /** Precipitation probability for the hour, 0–100. */
  precipProb: number;
  weatherCode: number;
}

/** Parsed Open-Meteo forecast for a single location. */
export interface Forecast {
  lat: number;
  lon: number;
  tz: string;
  days: DayForecast[];
  hours: HourForecast[];
}

/** Result of geocoding a place name. */
export interface GeocodeResult {
  lat: number;
  lon: number;
  /** Canonical place name returned by Open-Meteo. */
  name: string;
  /** First-level administrative region (e.g. oblast), may be empty. */
  admin1: string;
}

/** Stored user coordinates (`user.coords` in `memory_facts`). */
export interface Coords {
  city: string;
  lat: number;
  lon: number;
}

/**
 * Minimal Open-Meteo client surface the `weather` tool depends on. The server
 * injects its real client (packages/server/src/weather/open-meteo.ts), whose
 * functions satisfy this structurally.
 */
export interface WeatherClientLike {
  /** Default timezone for forecasts (env `WEATHER_TZ`). */
  tz: string;
  fetchForecast(lat: number, lon: number, tz: string, days?: number): Promise<Forecast>;
  geocode(name: string): Promise<GeocodeResult | null>;
  /** Short Russian 3-day overview built from the daily block. */
  formatBriefOutlook(forecast: Forecast): string;
  /** WMO weather code → short Russian description. */
  wmoToRu(code: number): string;
}

/** Resolve the user's cached coordinates (geocode-on-first-use). */
export type ResolveUserCoordsFn = () => Promise<Coords | null>;
