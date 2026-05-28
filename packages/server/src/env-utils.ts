export function envInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return fallback;
  if (max !== undefined && i > max) return fallback;
  return i;
}
