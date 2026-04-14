/**
 * chat.ts prepends `[DD.MM.YYYY, HH:MM]` to every message before sending it to
 * the model (see `addTimestamps`). This module centralizes the regex used to
 * strip that prefix in two situations:
 *
 *   - Input cleanup: extracting the user's raw text from a stored message so
 *     it can be used as a memory-search query without embedding the bracket.
 *   - Output cleanup: qwen2.5 tends to mirror the bracket prefix in its own
 *     reply ("[14.04.2026, 10:39] 4"); strip it before the UI sees it.
 *     Claude does not exhibit this quirk.
 *
 * The regex matches only a LEADING bracket, so assistant text that legitimately
 * contains `[DD.MM.YYYY, HH:MM]` mid-sentence is preserved.
 */
const TIMESTAMP_PREFIX_RE = /^\[\d{2}\.\d{2}\.\d{4}[^\]]*\]\s*/;

export function stripTimestampPrefix(text: string): string {
  return text.replace(TIMESTAMP_PREFIX_RE, '');
}
