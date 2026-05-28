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
