import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchForecast,
  geocode,
  formatBriefOutlook,
  wmoToRu,
  WMO_RU,
} from '../open-meteo.js';
import type { Forecast } from '../types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

const FORECAST_BODY = {
  latitude: 50.0,
  longitude: 36.25,
  timezone: 'Europe/Kyiv',
  daily: {
    time: ['2026-06-03', '2026-06-04', '2026-06-05'],
    temperature_2m_max: [20.4, 18.1, 8.3],
    temperature_2m_min: [12.1, 10.0, 2.4],
    precipitation_probability_max: [10, 80, 30],
    weathercode: [1, 61, 3],
    wind_speed_10m_max: [15.0, 25.0, 12.0],
  },
  hourly: {
    time: ['2026-06-03T00:00', '2026-06-03T01:00'],
    temperature_2m: [13.0, 12.5],
    precipitation_probability: [5, 10],
    weathercode: [1, 2],
    wind_speed_10m: [8.0, 9.0],
  },
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('fetchForecast', () => {
  it('parses daily + hourly into a Forecast', async () => {
    mockFetch.mockResolvedValueOnce(okJson(FORECAST_BODY));

    const fc = await fetchForecast(50.0, 36.25, 'Europe/Kyiv', 3);

    expect(fc.lat).toBe(50.0);
    expect(fc.lon).toBe(36.25);
    expect(fc.tz).toBe('Europe/Kyiv');
    expect(fc.days).toHaveLength(3);
    expect(fc.days[1]).toEqual({
      date: '2026-06-04',
      tempMax: 18.1,
      tempMin: 10.0,
      precipProbMax: 80,
      weatherCode: 61,
      windMax: 25.0,
    });
    expect(fc.hours).toHaveLength(2);
    expect(fc.hours[0]).toEqual({
      time: '2026-06-03T00:00',
      temp: 13.0,
      precipProb: 5,
      weatherCode: 1,
      wind: 8.0,
    });
  });

  it('builds the request URL with daily/hourly/timezone/forecast_days params', async () => {
    mockFetch.mockResolvedValueOnce(okJson(FORECAST_BODY));

    await fetchForecast(50.0, 36.25, 'Europe/Kyiv', 3);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('api.open-meteo.com/v1/forecast');
    expect(url).toContain('latitude=50');
    expect(url).toContain('longitude=36.25');
    expect(url).toContain('timezone=Europe%2FKyiv');
    expect(url).toContain('forecast_days=3');
    expect(url).toContain('temperature_2m_max');
    expect(url).toContain('precipitation_probability');
    // Canonical Open-Meteo variable name (snake_case), not the legacy alias.
    expect(url).toContain('weather_code');
    expect(url).not.toContain('weathercode');
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.signal).toBeDefined();
  });

  it('parses the canonical weather_code field from the response', async () => {
    const body = {
      ...FORECAST_BODY,
      daily: { ...FORECAST_BODY.daily, weathercode: undefined, weather_code: [2, 95, 0] },
      hourly: { ...FORECAST_BODY.hourly, weathercode: undefined, weather_code: [3, 45] },
    };
    mockFetch.mockResolvedValueOnce(okJson(body));

    const fc = await fetchForecast(50.0, 36.25, 'Europe/Kyiv', 3);

    expect(fc.days.map((d) => d.weatherCode)).toEqual([2, 95, 0]);
    expect(fc.hours.map((h) => h.weatherCode)).toEqual([3, 45]);
  });

  it('coerces null precip-probability to 0', async () => {
    const body = {
      ...FORECAST_BODY,
      daily: {
        ...FORECAST_BODY.daily,
        precipitation_probability_max: [null, 80, 30],
      },
    };
    mockFetch.mockResolvedValueOnce(okJson(body));

    const fc = await fetchForecast(50.0, 36.25, 'Europe/Kyiv', 3);
    expect(fc.days[0].precipProbMax).toBe(0);
  });

  it('coerces a missing daily temp to NaN (not a fabricated 0° frost)', async () => {
    const body = {
      ...FORECAST_BODY,
      daily: {
        ...FORECAST_BODY.daily,
        temperature_2m_min: [12.1, null, 2.4],
      },
    };
    mockFetch.mockResolvedValueOnce(okJson(body));

    const fc = await fetchForecast(50.0, 36.25, 'Europe/Kyiv', 3);
    expect(Number.isNaN(fc.days[1].tempMin)).toBe(true);
  });

  it('throws on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(fetchForecast(50, 36, 'Europe/Kyiv')).rejects.toThrow(/503/);
  });

  it('propagates fetch timeout/abort errors', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(fetchForecast(50, 36, 'Europe/Kyiv')).rejects.toThrow(/timed out/);
  });

  it('throws when daily block is missing', async () => {
    mockFetch.mockResolvedValueOnce(okJson({ hourly: {} }));
    await expect(fetchForecast(50, 36, 'Europe/Kyiv')).rejects.toThrow(/daily/);
  });
});

describe('geocode', () => {
  it('returns the top match', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({
        results: [
          {
            latitude: 50.05,
            longitude: 36.3,
            name: 'Kalynivka',
            admin1: 'Kharkiv Oblast',
          },
        ],
      }),
    );

    const hit = await geocode('Калиновка', { country: 'UA' });
    expect(hit).toEqual({
      lat: 50.05,
      lon: 36.3,
      name: 'Kalynivka',
      admin1: 'Kharkiv Oblast',
    });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('geocoding-api.open-meteo.com/v1/search');
    expect(url).toContain('countryCode=UA');
    expect(url).toContain('language=ru');
    expect(url).toContain('count=1');
  });

  it('omits the country filter when none is given (resolves any city)', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ results: [{ latitude: 52.52, longitude: 13.4, name: 'Berlin' }] }),
    );
    const hit = await geocode('Berlin');
    expect(hit?.name).toBe('Berlin');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).not.toContain('countryCode');
  });

  it('returns null when there are no results', async () => {
    mockFetch.mockResolvedValueOnce(okJson({}));
    expect(await geocode('Nowhereville')).toBeNull();
  });

  it('defaults admin1 to empty string when absent', async () => {
    mockFetch.mockResolvedValueOnce(
      okJson({ results: [{ latitude: 1, longitude: 2, name: 'X' }] }),
    );
    const hit = await geocode('X');
    expect(hit?.admin1).toBe('');
  });

  it('throws on non-2xx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(geocode('X')).rejects.toThrow(/500/);
  });
});

describe('wmoToRu / WMO_RU', () => {
  it('maps known codes to RU', () => {
    expect(wmoToRu(0)).toBe('ясно');
    expect(wmoToRu(61)).toBe('слабый дождь');
    expect(wmoToRu(95)).toBe('гроза');
    expect(WMO_RU[3]).toBe('пасмурно');
  });

  it('falls back for unknown codes', () => {
    expect(wmoToRu(123)).toBe('код 123');
  });
});

describe('formatBriefOutlook', () => {
  it('produces a short 3-day RU overview (snapshot)', () => {
    const fc: Forecast = {
      lat: 50,
      lon: 36,
      tz: 'Europe/Kyiv',
      days: [
        { date: '2026-06-03', tempMax: 20.4, tempMin: 12.1, precipProbMax: 10, weatherCode: 1, windMax: 15 },
        { date: '2026-06-04', tempMax: 18.1, tempMin: 10.0, precipProbMax: 80, weatherCode: 61, windMax: 25 },
        { date: '2026-06-05', tempMax: 8.3, tempMin: 2.4, precipProbMax: 30, weatherCode: 3, windMax: 12 },
      ],
      hours: [],
    };
    expect(formatBriefOutlook(fc)).toBe(
      'Сегодня: преимущественно ясно, 12–20°\n' +
        'Завтра: слабый дождь, 10–18° (осадки 80%)\n' +
        'Послезавтра: пасмурно, 2–8°',
    );
  });

  it('uses the date as label beyond 3 days', () => {
    const fc: Forecast = {
      lat: 0,
      lon: 0,
      tz: 'Europe/Kyiv',
      days: [
        { date: '2026-06-03', tempMax: 1, tempMin: 0, precipProbMax: 0, weatherCode: 0, windMax: 0 },
        { date: '2026-06-04', tempMax: 1, tempMin: 0, precipProbMax: 0, weatherCode: 0, windMax: 0 },
        { date: '2026-06-05', tempMax: 1, tempMin: 0, precipProbMax: 0, weatherCode: 0, windMax: 0 },
        { date: '2026-06-06', tempMax: 1, tempMin: 0, precipProbMax: 0, weatherCode: 0, windMax: 0 },
      ],
      hours: [],
    };
    expect(formatBriefOutlook(fc)).toContain('2026-06-06: ясно');
  });

  it('shows "темп. н/д" for a day with missing (NaN) temps', () => {
    const fc: Forecast = {
      lat: 0,
      lon: 0,
      tz: 'Europe/Kyiv',
      days: [
        { date: '2026-06-03', tempMax: NaN, tempMin: NaN, precipProbMax: 0, weatherCode: 1, windMax: 0 },
      ],
      hours: [],
    };
    expect(formatBriefOutlook(fc)).toBe('Сегодня: преимущественно ясно, темп. н/д');
  });

  it('shows "темп. н/д" when only one of the day temps is NaN', () => {
    const fc: Forecast = {
      lat: 0,
      lon: 0,
      tz: 'Europe/Kyiv',
      days: [
        { date: '2026-06-03', tempMax: NaN, tempMin: 3, precipProbMax: 0, weatherCode: 1, windMax: 0 },
      ],
      hours: [],
    };
    expect(formatBriefOutlook(fc)).toBe('Сегодня: преимущественно ясно, темп. н/д');
  });

  it('returns a fallback when there are no days', () => {
    const fc: Forecast = { lat: 0, lon: 0, tz: 'Europe/Kyiv', days: [], hours: [] };
    expect(formatBriefOutlook(fc)).toBe('погода недоступна');
  });
});
