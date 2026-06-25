/**
 * Pure, deterministic normalization of a window into a stable matching key of
 * the form `<app>:<token>`, used to bias the distraction judge with past button
 * feedback (see the iter-2 feedback-loop design spec §1).
 *
 * The app prefix is only a namespace — it prevents a Discord channel word and a
 * Telegram word that normalize the same from colliding. The title-derived token
 * is the real discriminator (Chrome `facebook` vs Chrome `localhost`), so this
 * is NOT app-level matching.
 *
 * An empty / uninformative / null title yields `''` (no matching) — it does NOT
 * fall back to `<app>:`, so blank-title dwells never bucket together.
 */

// Known social/feed domains matched by lowercase substring scan over the title.
const KNOWN_DOMAINS = [
  'youtube',
  'facebook',
  'twitch',
  'instagram',
  'reddit',
  'telegram',
];

// Generic host extractor — first `<name>.<tld>` token in the title.
const HOST_RE = /\b([a-z0-9-]+)\.(?:com|org|net|tv|io|me)\b/;

/** Strip emoji/pictographs and edge punctuation, keeping inner word chars. */
function cleanToken(token: string): string {
  const noEmoji = token.replace(/[\p{Extended_Pictographic}️]/gu, '');
  return noEmoji
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '');
}

export function titleSignature(app: string, title: string | null): string {
  if (!title) return '';
  const trimmed = title.trim();
  if (trimmed === '') return '';

  const lower = trimmed.toLowerCase();

  // 1. Known-domain substring scan.
  for (const domain of KNOWN_DOMAINS) {
    if (lower.includes(domain)) return `${app}:${domain}`;
  }

  // 2. Generic host extractor.
  const host = lower.match(HOST_RE);
  if (host) return `${app}:${host[1]}`;

  // 3. First meaningful word: lowercase, length >= 2, not all-digits.
  for (const raw of trimmed.split(/\s+/)) {
    const token = cleanToken(raw).toLowerCase();
    if (token.length >= 2 && !/^\d+$/.test(token)) {
      return `${app}:${token}`;
    }
  }

  return '';
}
