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
// by two hex digits. Used in the string branch of decodeBodyPart together
// with the bodyStructure-reported encoding: we only invoke libqp.decode when
// the encoding is explicitly 'quoted-printable' AND markers are present, so
// that (a) plain unicode strings declared as QP aren't fed through latin1
// round-trip and corrupted, and (b) innocent strings containing '=XX' (URL
// params like '?utm=A1B2', hex color codes) aren't mis-decoded.
const QP_HEURISTIC = /=[0-9A-F]{2}/i;

function decodeBytes(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1'), 'base64');
  if (enc === 'quoted-printable') return libqp.decode(buf.toString('latin1'));
  // 7bit / 8bit / binary / empty / unknown — pass the buffer through unchanged
  // and let toUtf8 handle charset. Blanket-QP fallback on unknown encodings is
  // exactly the bug this rewrite is meant to fix (legitimate 8bit text gets
  // garbled when fed through libqp).
  return buf;
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
    // Only re-decode when the part is declared quoted-printable AND the
    // string still has QP markers. Either condition alone is wrong: encoding
    // alone would mangle already-decoded unicode (latin1 round-trip), markers
    // alone would corrupt innocent strings containing '=XX' substrings.
    if (
      (encoding || '').toLowerCase() === 'quoted-printable' &&
      QP_HEURISTIC.test(value)
    ) {
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
  disposition?: string;
  childNodes?: BodyStructureNode[] | null;
};

export type PickedPart = { partId: string; encoding: string; charset: string; type: string };

// Walk the bodyStructure tree (multipart/alternative, multipart/mixed, ...).
// Prefer text/plain over text/html so the snippet is closer to what the
// sender's mail client showed; fall back to text/html or whichever leaf comes
// first if no plain-text part exists. Returns null when there's no text leaf
// at all (image-only / attachment-only messages — caller surfaces empty body
// rather than raw base64 of a JPEG).
//
// The `inAttachment` flag is carried down into recursion so a multipart
// container marked Content-Disposition: attachment (e.g. message/rfc822
// forwards, multipart/mixed bundled as an attachment) skips its entire
// subtree. Otherwise a text/plain inside the forwarded message would be
// preferred over the real outer text/html body.
export function pickTextPart(bodyStructure: unknown): PickedPart | null {
  if (!bodyStructure || typeof bodyStructure !== 'object') return null;
  const leaves: PickedPart[] = [];
  const walk = (node: BodyStructureNode, inAttachment: boolean): void => {
    if (!node || typeof node !== 'object') return;
    const disposition = (node.disposition || '').toLowerCase();
    const isAttachment = inAttachment || disposition === 'attachment';
    if (Array.isArray(node.childNodes) && node.childNodes.length > 0) {
      for (const child of node.childNodes) walk(child, isAttachment);
      return;
    }
    const type = (node.type || '').toLowerCase();
    if (type.startsWith('text/') && !isAttachment) {
      leaves.push({
        partId: node.part || '1',
        encoding: (node.encoding || '').toLowerCase(),
        charset: (node.parameters?.charset || 'utf-8').toLowerCase(),
        type,
      });
    }
  };
  walk(bodyStructure as BodyStructureNode, false);
  if (leaves.length === 0) return null;
  const plain = leaves.find((l) => l.type === 'text/plain');
  return plain || leaves[0];
}
