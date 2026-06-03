import { describe, it, expect, vi } from 'vitest';
import { createTool, isSamePlace } from '../index.js';
import type {
  Coords,
  Forecast,
  GeocodeResult,
  ResolveUserCoordsFn,
  WeatherClientLike,
} from '../types.js';

function mkForecast(lat: number, lon: number): Forecast {
  return {
    lat,
    lon,
    tz: 'Europe/Kyiv',
    days: [
      { date: '2026-06-03', tempMax: 20.4, tempMin: 11.6, precipProbMax: 10, weatherCode: 1, windMax: 12.3 },
      { date: '2026-06-04', tempMax: 18.2, tempMin: 10.1, precipProbMax: 70, weatherCode: 63, windMax: 22.7 },
      { date: '2026-06-05', tempMax: 8.5, tempMin: 2.0, precipProbMax: 40, weatherCode: 3, windMax: 9.0 },
    ],
    hours: [],
  };
}

function mkClient(overrides: Partial<WeatherClientLike> = {}): WeatherClientLike {
  return {
    tz: 'Europe/Kyiv',
    fetchForecast: vi.fn(async (lat: number, lon: number) => mkForecast(lat, lon)),
    geocode: vi.fn(async (): Promise<GeocodeResult | null> => ({
      lat: 49.1,
      lon: 36.5,
      name: 'Калиновка',
      admin1: 'Харьковская область',
    })),
    formatBriefOutlook: vi.fn(() => 'Сегодня ясно; завтра дождь; послезавтра холодает'),
    wmoToRu: vi.fn((code: number) => `код ${code}`),
    ...overrides,
  };
}

const userCoords = (): ResolveUserCoordsFn =>
  vi.fn(async (): Promise<Coords | null> => ({ city: 'Калиновка', lat: 49.9, lon: 36.9 }));

function getTool(deps: Parameters<typeof createTool>[0]) {
  return createTool(deps).find((t) => t.name === 'weather')!;
}

describe('isSamePlace — home-city matcher', () => {
  it('matches exact normalized equality', () => {
    expect(isSamePlace('Калиновка', 'Калиновка')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSamePlace('калиновка', 'КАЛИНОВКА')).toBe(true);
  });

  it('matches when home has an oblast suffix (first segment only)', () => {
    expect(isSamePlace('Калиновка', 'Калиновка, Харьковская область, Украина')).toBe(true);
  });

  it('matches when input has an oblast suffix', () => {
    expect(isSamePlace('Калиновка, Харьковская область', 'Калиновка')).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    expect(isSamePlace('  Калиновка  ', 'Калиновка')).toBe(true);
  });

  it('does not match a different city', () => {
    expect(isSamePlace('Киев', 'Калиновка')).toBe(false);
  });

  it('does not substring-match', () => {
    expect(isSamePlace('Кали', 'Калиновка')).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(isSamePlace('', 'Калиновка')).toBe(false);
    expect(isSamePlace('   ', 'Калиновка')).toBe(false);
  });

  it('returns false on empty home city', () => {
    expect(isSamePlace('Калиновка', '')).toBe(false);
  });
});

describe('weather tool — no location (user coords)', () => {
  it('resolves user coords and returns structural 3-day forecast + RU summary', async () => {
    const weatherClient = mkClient();
    const resolveUserCoords = userCoords();
    const tool = getTool({ weatherClient, resolveUserCoords });

    const res = await tool.handler({});
    expect(res.success).toBe(true);
    expect(resolveUserCoords).toHaveBeenCalledOnce();
    // user coords used, geocode NOT called
    expect(weatherClient.geocode).not.toHaveBeenCalled();
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(49.9, 36.9, 'Europe/Kyiv');

    const data = res.data as Record<string, unknown>;
    expect(data.location).toEqual({ name: 'Калиновка', lat: 49.9, lon: 36.9 });
    expect(data.summary).toContain('Сегодня ясно');
    const days = data.days as Array<Record<string, unknown>>;
    expect(days).toHaveLength(3);
    expect(days[0]).toEqual({
      date: '2026-06-03',
      temp_min: 12,
      temp_max: 20,
      precip_prob: 10,
      weather_code: 1,
      weather_ru: 'код 1',
      wind_max: 12,
    });
  });

  it('errors when user coords cannot be resolved', async () => {
    const weatherClient = mkClient();
    const tool = getTool({ weatherClient, resolveUserCoords: vi.fn(async () => null) });
    const res = await tool.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/координаты/i);
    expect(weatherClient.fetchForecast).not.toHaveBeenCalled();
  });

  it('errors when no resolver is wired', async () => {
    const tool = getTool({ weatherClient: mkClient(), resolveUserCoords: null });
    const res = await tool.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/координаты/i);
  });
});

describe('weather tool — with location (geocode)', () => {
  it('geocodes a different city and forecasts there', async () => {
    const weatherClient = mkClient({
      geocode: vi.fn(async (): Promise<GeocodeResult | null> => ({
        lat: 50.45,
        lon: 30.52,
        name: 'Киев',
        admin1: 'Киев',
      })),
    });
    const resolveUserCoords = userCoords();
    const tool = getTool({ weatherClient, resolveUserCoords });

    const res = await tool.handler({ location: '  Киев  ' });
    expect(res.success).toBe(true);
    // trimmed before geocoding; not the home city, so override coords NOT used
    expect(weatherClient.geocode).toHaveBeenCalledWith('Киев');
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(50.45, 30.52, 'Europe/Kyiv');

    const data = res.data as Record<string, unknown>;
    expect(data.location).toEqual({ name: 'Киев, Киев', lat: 50.45, lon: 30.52 });
  });

  it('uses override home coords when location is the home city (no geocode)', async () => {
    const weatherClient = mkClient();
    const resolveUserCoords = userCoords();
    const tool = getTool({ weatherClient, resolveUserCoords });

    const res = await tool.handler({ location: 'Калиновка' });
    expect(res.success).toBe(true);
    // home-match short-circuit: override coords used, geocode NOT called
    expect(resolveUserCoords).toHaveBeenCalledOnce();
    expect(weatherClient.geocode).not.toHaveBeenCalled();
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(49.9, 36.9, 'Europe/Kyiv');

    const data = res.data as Record<string, unknown>;
    expect(data.location).toEqual({ name: 'Калиновка', lat: 49.9, lon: 36.9 });
  });

  it('matches home city case-insensitively / with oblast suffix', async () => {
    const weatherClient = mkClient();
    const resolveUserCoords = userCoords();
    const tool = getTool({ weatherClient, resolveUserCoords });

    const res = await tool.handler({ location: 'калиновка, Харьковская область' });
    expect(res.success).toBe(true);
    expect(weatherClient.geocode).not.toHaveBeenCalled();
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(49.9, 36.9, 'Europe/Kyiv');
  });

  it('still geocodes a different city when the home probe throws (best-effort)', async () => {
    const weatherClient = mkClient({
      geocode: vi.fn(async (): Promise<GeocodeResult | null> => ({
        lat: 50.45,
        lon: 30.52,
        name: 'Киев',
        admin1: 'Киев',
      })),
    });
    // Home resolver may network-geocode the village and fail; a request for a
    // DIFFERENT city must not inherit that error.
    const resolveUserCoords = vi.fn(async (): Promise<Coords | null> => {
      throw new Error('home geocode down');
    });
    const tool = getTool({ weatherClient, resolveUserCoords });

    const res = await tool.handler({ location: 'Киев' });
    expect(res.success).toBe(true);
    expect(resolveUserCoords).toHaveBeenCalledOnce();
    expect(weatherClient.geocode).toHaveBeenCalledWith('Киев');
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(50.45, 30.52, 'Europe/Kyiv');
  });

  it('falls back to geocoding the name when no resolver is wired (legacy)', async () => {
    const weatherClient = mkClient();
    const tool = getTool({ weatherClient, resolveUserCoords: null });

    const res = await tool.handler({ location: 'Калиновка' });
    expect(res.success).toBe(true);
    expect(weatherClient.geocode).toHaveBeenCalledWith('Калиновка');
    expect(weatherClient.fetchForecast).toHaveBeenCalledWith(49.1, 36.5, 'Europe/Kyiv');
  });

  it('returns a clear error for an unknown city, never substituting another', async () => {
    const weatherClient = mkClient({ geocode: vi.fn(async () => null) });
    const tool = getTool({ weatherClient, resolveUserCoords: userCoords() });
    const res = await tool.handler({ location: 'Нетакогогорода' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Нетакогогорода');
    expect(weatherClient.fetchForecast).not.toHaveBeenCalled();
  });
});

describe('weather tool — failure modes', () => {
  it('returns {success:false,error} when the client throws', async () => {
    const weatherClient = mkClient({
      fetchForecast: vi.fn(async () => {
        throw new Error('Open-Meteo forecast error: 503');
      }),
    });
    const tool = getTool({ weatherClient, resolveUserCoords: userCoords() });
    const res = await tool.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toBe('Open-Meteo forecast error: 503');
  });

  it('errors when weather integration is disabled', async () => {
    const tool = getTool({ weatherClient: null, resolveUserCoords: null });
    const res = await tool.handler({ location: 'Киев' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not enabled/i);
  });
});
