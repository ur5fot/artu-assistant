export function envInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  // Treat empty / whitespace-only env values as unset. Without this guard
  // `Number('') === 0` would silently coerce `EMAIL_SEND_HOLD_SECONDS=`
  // (a common typo: variable declared but value forgotten) into bypass mode,
  // disabling the hold-zone safety feature the user expected.
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return fallback;
  if (max !== undefined && i > max) return fallback;
  return i;
}

/**
 * Parse a boolean env flag. Only an exact (trimmed, case-insensitive) "true"
 * counts as true — mirroring the `=== 'true'` convention used throughout the
 * server. Empty / whitespace-only / undefined falls back to `fallback`, so a
 * declared-but-blank flag (a common typo) keeps its safe default.
 */
export function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

/**
 * Parse a comma-separated env value into a trimmed string[]. Empty entries
 * (from stray / trailing commas) and surrounding whitespace are dropped, so an
 * unset or blank value yields `[]`.
 */
export function envCsv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
