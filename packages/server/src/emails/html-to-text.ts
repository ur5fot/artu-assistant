// Minimal HTML→text conversion for email bodies. Used at the single decode
// chokepoint (imap-client `decodePickedText`) so that HTML-only messages stop
// leaking raw tags into the digest snippet, the LLM scorer input, `emails_get`,
// and the full-text action. Intentionally dependency-free (no `html-to-text`
// package) — emails rarely need full DOM fidelity, just readable plain text.

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    // Numeric entities: &#NNN; (decimal) or &#xHH; (hex).
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const codeStr = isHex ? body.slice(2) : body.slice(1);
      const code = parseInt(codeStr, isHex ? 16 : 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    // Named entities — only the common set seen in mail.
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

export function htmlToText(html: string): string {
  if (!html) return '';

  let text = html;

  // 1. Drop <script>…</script> and <style>…</style> including their contents.
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Also drop HTML comments (often carry conditional/ms-office cruft).
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Convert block boundaries to newlines so the text stays readable.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');

  // 3. Remove every remaining tag (incl. <!DOCTYPE …>, <html …>, etc.).
  text = text.replace(/<[^>]+>/g, '');

  // 4. Decode HTML entities — named and numeric.
  text = decodeEntities(text);

  // 5. Collapse whitespace: trim each line, drop runs of >1 blank line, and
  //    squeeze horizontal whitespace runs — compact but readable.
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
