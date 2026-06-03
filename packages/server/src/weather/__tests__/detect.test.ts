import { describe, it, expect } from 'vitest';
import { detectWeatherChanges } from '../detect.js';
import type { DayForecast, Forecast, HourForecast } from '../types.js';

// Deterministic frame: tz 'UTC' means local wall-clock strings == UTC epochs.
const NOW = Date.UTC(2026, 5, 3, 8, 0); // 2026-06-03T08:00Z

function day(date: string, o: Partial<DayForecast> = {}): DayForecast {
  return {
    date,
    tempMax: 18,
    tempMin: 8,
    precipProbMax: 10,
    weatherCode: 1,
    windMax: 10,
    ...o,
  };
}

function hour(time: string, o: Partial<HourForecast> = {}): HourForecast {
  return { time, temp: 15, precipProb: 0, weatherCode: 1, ...o };
}

function fc(o: Partial<Forecast> = {}): Forecast {
  return { lat: 0, lon: 0, tz: 'UTC', days: [], hours: [], ...o };
}

describe('detectWeatherChanges — temperature swing', () => {
  it('flags a sharp drop today→tomorrow', () => {
    const f = fc({
      days: [day('2026-06-03', { tempMax: 20 }), day('2026-06-04', { tempMax: 10 })],
    });
    const events = detectWeatherChanges(f, NOW);
    const swing = events.find((e) => e.type === 'temp-swing');
    expect(swing).toBeDefined();
    expect(swing!.key).toBe('temp-swing+2026-06-04');
    expect(swing!.message).toContain('холоднее');
    expect(swing!.message).toContain('Δ10°');
  });

  it('flags a sharp warm-up with "теплее"', () => {
    const f = fc({
      days: [day('2026-06-03', { tempMax: 5 }), day('2026-06-04', { tempMax: 18 })],
    });
    const swing = detectWeatherChanges(f, NOW).find((e) => e.type === 'temp-swing');
    expect(swing?.message).toContain('теплее');
  });

  it('does not flag a swing below the threshold', () => {
    const f = fc({
      days: [day('2026-06-03', { tempMax: 20 }), day('2026-06-04', { tempMax: 15 })],
    });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'temp-swing')).toBe(false);
  });

  it('respects a custom tempSwingC threshold', () => {
    const f = fc({
      days: [day('2026-06-03', { tempMax: 20 }), day('2026-06-04', { tempMax: 15 })],
    });
    const events = detectWeatherChanges(f, NOW, { tempSwingC: 4 });
    expect(events.some((e) => e.type === 'temp-swing')).toBe(true);
  });
});

describe('detectWeatherChanges — precipitation', () => {
  it('flags intraday rain inside the lead window', () => {
    const f = fc({
      days: [day('2026-06-03')],
      hours: [
        hour('2026-06-03T07:00', { precipProb: 0 }),
        hour('2026-06-03T08:00', { precipProb: 5 }),
        hour('2026-06-03T11:00', { precipProb: 80, weatherCode: 61 }),
      ],
    });
    const events = detectWeatherChanges(f, NOW);
    const rain = events.find((e) => e.type === 'precip');
    expect(rain).toBeDefined();
    expect(rain!.key).toBe('precip+2026-06-03');
    expect(rain!.message).toContain('~3ч');
    expect(rain!.when).toBe(Date.UTC(2026, 5, 3, 11, 0));
  });

  it('ignores a wet hour outside the lead window', () => {
    const f = fc({
      days: [day('2026-06-03')],
      hours: [
        hour('2026-06-03T08:00', { precipProb: 0 }),
        hour('2026-06-03T20:00', { precipProb: 90, weatherCode: 61 }),
      ],
    });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'precip')).toBe(false);
  });

  it('does not flag rain when it is already wet now', () => {
    const f = fc({
      days: [day('2026-06-03')],
      hours: [
        hour('2026-06-03T08:00', { precipProb: 90, weatherCode: 61 }),
        hour('2026-06-03T10:00', { precipProb: 90, weatherCode: 61 }),
      ],
    });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'precip')).toBe(false);
  });

  it('falls back to next-day daily precipitation', () => {
    const f = fc({
      days: [
        day('2026-06-03'),
        day('2026-06-04', { precipProbMax: 80, weatherCode: 63 }),
      ],
    });
    const rain = detectWeatherChanges(f, NOW).find((e) => e.type === 'precip');
    expect(rain).toBeDefined();
    expect(rain!.key).toBe('precip+2026-06-04');
    expect(rain!.message).toContain('Завтра осадки');
    expect(rain!.message).toContain('80%');
  });

  it('prefers an intraday hit over the daily fallback', () => {
    const f = fc({
      days: [
        day('2026-06-03'),
        day('2026-06-04', { precipProbMax: 80, weatherCode: 63 }),
      ],
      hours: [
        hour('2026-06-03T08:00', { precipProb: 0 }),
        hour('2026-06-03T10:00', { precipProb: 75, weatherCode: 61 }),
      ],
    });
    const rain = detectWeatherChanges(f, NOW).filter((e) => e.type === 'precip');
    expect(rain).toHaveLength(1);
    expect(rain[0].key).toBe('precip+2026-06-03');
  });
});

describe('detectWeatherChanges — frost', () => {
  it('flags an upcoming sub-zero night', () => {
    const f = fc({
      days: [day('2026-06-03'), day('2026-06-04', { tempMin: -3 })],
    });
    const frost = detectWeatherChanges(f, NOW).find((e) => e.type === 'frost');
    expect(frost).toBeDefined();
    expect(frost!.key).toBe('frost+2026-06-04');
    expect(frost!.message).toContain('до -3°');
  });

  it('does not flag frost when all mins stay above 0', () => {
    const f = fc({ days: [day('2026-06-03'), day('2026-06-04', { tempMin: 2 })] });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'frost')).toBe(false);
  });

  it('does not flag frost from a missing (NaN) tempMin', () => {
    // A partial Open-Meteo payload parses missing temps to NaN, not 0 — NaN must
    // not satisfy `tempMin <= 0` and fire a spurious frost ping.
    const f = fc({ days: [day('2026-06-03'), day('2026-06-04', { tempMin: NaN })] });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'frost')).toBe(false);
  });

  it('emits a frost event per qualifying day so today does not mask tomorrow', () => {
    // Today (2026-06-03) and tomorrow both sub-zero. The handler drops today's
    // (its `when` is in the past) — but tomorrow's must still be produced, so a
    // frost in progress today can never shadow tomorrow's pre-announce.
    const f = fc({
      days: [
        day('2026-06-03', { tempMin: -1 }),
        day('2026-06-04', { tempMin: -3 }),
      ],
    });
    const frostKeys = detectWeatherChanges(f, NOW)
      .filter((e) => e.type === 'frost')
      .map((e) => e.key);
    expect(frostKeys).toEqual(['frost+2026-06-03', 'frost+2026-06-04']);
  });
});

describe('detectWeatherChanges — storm / wind', () => {
  it('flags a thunderstorm by weathercode', () => {
    const f = fc({ days: [day('2026-06-03', { weatherCode: 95 })] });
    const storm = detectWeatherChanges(f, NOW).find((e) => e.type === 'storm');
    expect(storm).toBeDefined();
    expect(storm!.key).toBe('storm+2026-06-03');
    expect(storm!.message).toContain('Гроза');
  });

  it('flags strong wind above the threshold', () => {
    const f = fc({ days: [day('2026-06-03', { windMax: 60 })] });
    const storm = detectWeatherChanges(f, NOW).find((e) => e.type === 'storm');
    expect(storm).toBeDefined();
    expect(storm!.message).toContain('Сильный ветер');
    expect(storm!.message).toContain('60 км/ч');
  });

  it('does not flag calm winds with no thunder', () => {
    const f = fc({ days: [day('2026-06-03', { windMax: 20, weatherCode: 3 })] });
    expect(detectWeatherChanges(f, NOW).some((e) => e.type === 'storm')).toBe(false);
  });

  it('emits a storm event per qualifying day so today does not mask tomorrow', () => {
    const f = fc({
      days: [
        day('2026-06-03', { weatherCode: 95 }),
        day('2026-06-04', { windMax: 60 }),
      ],
    });
    const stormKeys = detectWeatherChanges(f, NOW)
      .filter((e) => e.type === 'storm')
      .map((e) => e.key);
    expect(stormKeys).toEqual(['storm+2026-06-03', 'storm+2026-06-04']);
  });
});

describe('detectWeatherChanges — quiescence & keys', () => {
  it('returns [] when nothing notable changes', () => {
    const f = fc({
      days: [day('2026-06-03'), day('2026-06-04')],
      hours: [hour('2026-06-03T08:00'), hour('2026-06-03T09:00')],
    });
    expect(detectWeatherChanges(f, NOW)).toEqual([]);
  });

  it('produces stable keys across repeated runs', () => {
    const f = fc({
      days: [
        day('2026-06-03', { tempMax: 20 }),
        day('2026-06-04', { tempMax: 10, tempMin: -2, windMax: 60 }),
      ],
    });
    const a = detectWeatherChanges(f, NOW).map((e) => e.key);
    const b = detectWeatherChanges(f, NOW).map((e) => e.key);
    expect(a).toEqual(b);
    expect(a).toContain('temp-swing+2026-06-04');
    expect(a).toContain('frost+2026-06-04');
  });
});

describe('detectWeatherChanges — zoned `when` resolution (non-UTC)', () => {
  // Europe/Kyiv in June is EEST (UTC+3), so local midnight 2026-06-04T00:00
  // resolves to 2026-06-03T21:00Z. This exercises the offset math that the
  // UTC-framed tests above no-op away.
  it('resolves a daily event to the correct UTC epoch under a +3 offset', () => {
    const f = fc({
      tz: 'Europe/Kyiv',
      days: [
        day('2026-06-03', { tempMax: 20 }),
        day('2026-06-04', { tempMax: 10, tempMin: -2 }),
      ],
    });
    const frost = detectWeatherChanges(f, NOW).find((e) => e.type === 'frost');
    expect(frost).toBeDefined();
    expect(frost!.when).toBe(Date.UTC(2026, 5, 3, 21, 0));
  });

  it('resolves an intraday event to the correct UTC epoch under a +3 offset', () => {
    const f = fc({
      tz: 'Europe/Kyiv',
      days: [day('2026-06-03')],
      hours: [
        hour('2026-06-03T10:00', { precipProb: 0 }), // 07:00Z — at/just before NOW
        hour('2026-06-03T14:00', { precipProb: 80, weatherCode: 61 }), // 11:00Z
      ],
    });
    const rain = detectWeatherChanges(f, NOW).find((e) => e.type === 'precip');
    expect(rain).toBeDefined();
    expect(rain!.when).toBe(Date.UTC(2026, 5, 3, 11, 0));
  });
});
