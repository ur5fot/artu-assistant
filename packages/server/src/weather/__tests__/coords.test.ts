import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb, initDb } from '../../db.js';
import { resolveCoords } from '../coords.js';
import type { GeocodeResult } from '../types.js';

beforeEach(() => initDb(':memory:'));

const NOW = Date.UTC(2026, 5, 3, 8, 0);

function geocodeHit(o: Partial<GeocodeResult> = {}): GeocodeResult {
  return { lat: 49.7, lon: 36.3, name: 'Kalynivka', admin1: 'Kharkiv', ...o };
}

/** Read the active stored user.coords JSON, or null. */
function storedCoords(): unknown {
  const row = getDb()
    .prepare(
      `SELECT value FROM memory_facts WHERE key = 'user.coords' AND superseded_by IS NULL AND forgotten = 0`,
    )
    .get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

describe('resolveCoords', () => {
  it('geocodes and persists when no record exists', async () => {
    const geocode = vi.fn(async () => geocodeHit());
    const coords = await resolveCoords(getDb(), 'Калиновка', geocode, { now: NOW });

    expect(geocode).toHaveBeenCalledOnce();
    expect(geocode).toHaveBeenCalledWith('Калиновка');
    expect(coords).toEqual({ city: 'Калиновка', lat: 49.7, lon: 36.3 });
    expect(storedCoords()).toEqual({ city: 'Калиновка', lat: 49.7, lon: 36.3 });
  });

  it('returns cached coords without geocoding when city matches', async () => {
    const geocode = vi.fn(async () => geocodeHit());
    await resolveCoords(getDb(), 'Калиновка', geocode, { now: NOW });
    geocode.mockClear();

    const coords = await resolveCoords(getDb(), 'Калиновка', geocode, { now: NOW });
    expect(geocode).not.toHaveBeenCalled();
    expect(coords).toEqual({ city: 'Калиновка', lat: 49.7, lon: 36.3 });
  });

  it('re-geocodes when the city changed', async () => {
    const geocode = vi
      .fn<(name: string) => Promise<GeocodeResult | null>>()
      .mockResolvedValueOnce(geocodeHit())
      .mockResolvedValueOnce(geocodeHit({ lat: 50.4, lon: 30.5, name: 'Kyiv' }));

    await resolveCoords(getDb(), 'Калиновка', geocode, { now: NOW });
    const coords = await resolveCoords(getDb(), 'Киев', geocode, { now: NOW });

    expect(geocode).toHaveBeenCalledTimes(2);
    expect(geocode).toHaveBeenLastCalledWith('Киев');
    expect(coords).toEqual({ city: 'Киев', lat: 50.4, lon: 30.5 });
    expect(storedCoords()).toEqual({ city: 'Киев', lat: 50.4, lon: 30.5 });
  });

  it('returns null when geocode finds nothing', async () => {
    const geocode = vi.fn(async () => null);
    const coords = await resolveCoords(getDb(), 'Нигде', geocode, { now: NOW });

    expect(coords).toBeNull();
    expect(storedCoords()).toBeNull();
  });

  it('uses env override without DB or geocode', async () => {
    const geocode = vi.fn(async () => geocodeHit());
    const coords = await resolveCoords(getDb(), 'Калиновка', geocode, {
      override: { lat: 49.123, lon: 36.456 },
      now: NOW,
    });

    expect(geocode).not.toHaveBeenCalled();
    expect(coords).toEqual({ city: 'Калиновка', lat: 49.123, lon: 36.456 });
    // Override does not persist — it is a runtime pin, not a cached value.
    expect(storedCoords()).toBeNull();
  });
});
