/**
 * MIME decode helpers shared by `imap-client` (snippet + full body paths).
 *
 * Exported helpers:
 * - {@link decodeHeader}  — RFC 2047 `=?utf-8?Q?…?=` / `=?utf-8?B?…?=` words
 *   in Subject / From / To headers, with a try/catch fallback to the raw
 *   string so a malformed header never throws.
 * - {@link decodeBodyPart} — dispatches a fetched body part by its
 *   Content-Transfer-Encoding (base64 / quoted-printable / 7bit / 8bit /
 *   unknown), then converts the resulting bytes to a UTF-8 string using the
 *   part's declared charset (via `iconv-lite`).
 * - {@link pickTextPart} — walks the `bodyStructure` tree of a message and
 *   returns the partId + encoding + charset of the text leaf to fetch,
 *   preferring `text/plain` over `text/html`. Returns `null` for
 *   attachment-only messages so the caller can surface an empty snippet
 *   instead of base64-encoded image bytes.
 *
 * Why dispatch on `bodyStructure` rather than blanket-QP-decode every value:
 * HTML payloads from Upwork / Djinni / marketing tools arrive as base64, and
 * running `libqp.decode` over them produced gibberish (`PHN0eWxlPi4uLg==`
 * snippets in digests). Once the bytes are decoded we still need a charset
 * pass — non-UTF-8 mail (KOI8-R, ISO-8859-1) was being mis-rendered as
 * mojibake. The encoding/charset are reported per-part by the IMAP server in
 * the same `fetchAll` call that returns envelope+internalDate, so this
 * dispatch costs no extra round-trips.
 */
import libqp from 'libqp';
import libmime from 'libmime';
import iconv from 'iconv-lite';

export function decodeHeader(s: string | null | undefined): string {
  if (!s) return '';
  try { return libmime.decodeWords(s); } catch { return s; }
}

// quoted-printable encoded bytes look like "=D0=9F" — a literal '=' followed
// by two hex digits. We use this to tell whether a string value that landed
// on us has already been decoded by imapflow (in which case it would contain
// raw unicode codepoints) or is still raw QP. Without the check we'd corrupt
// already-decoded strings by feeding them back into libqp.
const QP_HEURISTIC = /=[0-9A-F]{2}/i;

function decodeBytes(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1'), 'base64');
  if (enc === 'quoted-printable') return libqp.decode(buf.toString('latin1'));
  if (enc === '7bit' || enc === '8bit' || enc === 'binary' || enc === '') return buf;
  // Unknown encoding — log path is the caller's; here we fall through to QP
  // (the most common offender in practice) rather than dropping the body.
  return libqp.decode(buf.toString('latin1'));
}

function toUtf8(buf: Buffer, charset: string | null): string {
  const cs = (charset || 'utf-8').toLowerCase();
  try {
    if (iconv.encodingExists(cs)) return iconv.decode(buf, cs);
  } catch {
    // fall through to utf-8 best-effort below
  }
  return buf.toString('utf-8');
}

export function decodeBodyPart(
  value: unknown,
  encoding: string | null,
  charset: string | null,
): string {
  if (value == null) return '';
  if (Buffer.isBuffer(value)) {
    const bytes = decodeBytes(value, encoding);
    return toUtf8(bytes, charset);
  }
  if (typeof value === 'string') {
    // imapflow sometimes returns already-decoded unicode strings for plain
    // ASCII / 7bit parts. Only re-decode when we see actual QP markers,
    // otherwise we round-trip unicode through latin1 and corrupt it.
    if (QP_HEURISTIC.test(value)) {
      return toUtf8(libqp.decode(value), charset);
    }
    return value;
  }
  return '';
}

type BodyStructureNode = {
  type?: string;
  encoding?: string;
  parameters?: Record<string, string | undefined> | null;
  part?: string;
  childNodes?: BodyStructureNode[] | null;
};

type PickedPart = { partId: string; encoding: string; charset: string; type: string };

// Walk the bodyStructure tree (multipart/alternative, multipart/mixed, ...).
// Prefer text/plain over text/html so the snippet is closer to what the
// sender's mail client showed; fall back to text/html or whichever leaf comes
// first if no plain-text part exists. Returns null when there's no text leaf
// at all (image-only / attachment-only messages — caller surfaces empty body
// rather than raw base64 of a JPEG).
export function pickTextPart(bodyStructure: unknown): PickedPart | null {
  if (!bodyStructure || typeof bodyStructure !== 'object') return null;
  const leaves: PickedPart[] = [];
  const walk = (node: BodyStructureNode): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const type = (node.type || '').toLowerCase();
    if (type.startsWith('text/')) {
      leaves.push({
        partId: node.part || '1',
        encoding: (node.encoding || '').toLowerCase(),
        charset: (node.parameters?.charset || 'utf-8').toLowerCase(),
        type,
      });
    }
  };
  walk(bodyStructure as BodyStructureNode);
  if (leaves.length === 0) return null;
  const plain = leaves.find((l) => l.type === 'text/plain');
  return plain || leaves[0];
}
