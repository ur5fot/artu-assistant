// Resolve and cache user coordinates for weather lookups.
//
// Coordinates are stored once (geocode-on-first-use, re-geocode when the city
// changes) under `user.coords` in `memory_facts`, so the runtime never geocodes
// on every forecast. A manual `WEATHER_LAT`/`WEATHER_LON` override always wins —
// it lets the operator pin exact coordinates when Open-Meteo doesn't know a
// small village.

import type Database from 'better-sqlite3';
import type { Coords, GeocodeResult } from './types.js';

const COORDS_KEY = 'user.coords';

/** Geocode a place name (top match) or `null` when nothing matches. */
export type GeocodeFn = (name: string) => Promise<GeocodeResult | null>;

export interface ResolveCoordsOptions {
  /** Manual coordinate override (env `WEATHER_LAT`/`WEATHER_LON`); highest priority. */
  override?: { lat: number; lon: number };
  /** Timestamp for stored rows (defaults to `Date.now()`). */
  now?: number;
}

/**
 * Resolve coordinates for `city`:
 * - `override` present → use it verbatim (no DB, no geocode).
 * - cached `user.coords` matches `city` → return cached coords (no network).
 * - missing or city changed → `geocode(city)`, persist, and return it.
 * - geocode finds nothing → `null` (caller disables weather + logs a hint).
 */
export async function resolveCoords(
  db: Database.Database,
  city: string,
  geocode: GeocodeFn,
  opts: ResolveCoordsOptions = {},
): Promise<Coords | null> {
  if (opts.override) {
    return { city, lat: opts.override.lat, lon: opts.override.lon };
  }

  const cached = readCoords(db);
  if (cached && cached.city === city) {
    return cached;
  }

  const hit = await geocode(city);
  if (!hit) return null;

  const coords: Coords = { city, lat: hit.lat, lon: hit.lon };
  writeCoords(db, coords, opts.now ?? Date.now());
  return coords;
}

/** Read the active `user.coords` row, or `null` if absent/unparseable. */
function readCoords(db: Database.Database): Coords | null {
  const row = db
    .prepare(
      `SELECT value FROM memory_facts
       WHERE key = ? AND superseded_by IS NULL AND forgotten = 0
       LIMIT 1`,
    )
    .get(COORDS_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<Coords>;
    if (
      typeof parsed.city === 'string' &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number'
    ) {
      return { city: parsed.city, lat: parsed.lat, lon: parsed.lon };
    }
  } catch {
    // Corrupt JSON → treat as absent; the next geocode rewrites it.
  }
  return null;
}

/** Supersede any active `user.coords` row and insert the fresh value. */
function writeCoords(db: Database.Database, coords: Coords, now: number): void {
  const tx = db.transaction(() => {
    // Self-reference superseded_by so the unique partial index on active keys
    // no longer treats the old row as live before we insert the replacement.
    db.prepare(
      `UPDATE memory_facts SET superseded_by = id
       WHERE key = ? AND superseded_by IS NULL`,
    ).run(COORDS_KEY);
    db.prepare(
      `INSERT INTO memory_facts
         (key, value, created_at, last_mentioned_at, superseded_by, importance, forgotten)
       VALUES (?, ?, ?, ?, NULL, 1, 0)`,
    ).run(COORDS_KEY, JSON.stringify(coords), now, now);
  });
  tx();
}
