import { describe, it, expect } from 'vitest';
import { decodeHeader, decodeBodyPart, pickTextPart } from '../mime-decode.js';

describe('decodeHeader', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(decodeHeader('Hello world')).toBe('Hello world');
  });

  it('decodes RFC2047 quoted-printable encoded-word (UTF-8)', () => {
    expect(decodeHeader('=?UTF-8?Q?=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82=2C_=D0=BC=D0=B8=D1=80!?=')).toBe('Привет, мир!');
  });

  it('decodes RFC2047 base64 encoded-word (UTF-8)', () => {
    expect(decodeHeader('=?UTF-8?B?0J/RgNC40LLQtdGCLCDQvNC40YAh?=')).toBe('Привет, мир!');
  });

  it('decodes a non-UTF charset (KOI8-R)', () => {
    // libmime decodes the bytes via its charset table — we want to confirm
    // the helper does not throw on legacy encodings used by older Russian
    // mailers (smtp.mail.ru, qip.ru). Result may include normalization that
    // differs from iconv-lite, so we just assert it is the Russian string.
    const out = decodeHeader('=?KOI8-R?B?8NLJ18XU?=');
    expect(out).toBe('Привет');
  });

  it('returns empty string for null / undefined', () => {
    expect(decodeHeader(null)).toBe('');
    expect(decodeHeader(undefined)).toBe('');
    expect(decodeHeader('')).toBe('');
  });

  it('falls back to raw input on malformed encoded-word', () => {
    // not strictly malformed but ensures the try/catch path doesn't throw
    const broken = '=?utf-8?Q?not_terminated';
    expect(() => decodeHeader(broken)).not.toThrow();
  });
});

describe('decodeBodyPart (Buffer)', () => {
  it('decodes quoted-printable UTF-8 buffer', () => {
    const qp = Buffer.from('=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82, =D0=BC=D0=B8=D1=80!', 'latin1');
    expect(decodeBodyPart(qp, 'quoted-printable', 'utf-8')).toBe('Привет, мир!');
  });

  it('decodes base64 UTF-8 buffer', () => {
    const b64 = Buffer.from('0J/RgNC40LLQtdGCLCDQvNC40YAh', 'latin1');
    expect(decodeBodyPart(b64, 'base64', 'utf-8')).toBe('Привет, мир!');
  });

  it('returns 7bit ASCII buffer as-is', () => {
    const buf = Buffer.from('Plain ASCII text');
    expect(decodeBodyPart(buf, '7bit', 'utf-8')).toBe('Plain ASCII text');
  });

  it('decodes 8bit Latin-1 with charset hint', () => {
    // "café" in ISO-8859-1: 0x63 0x61 0x66 0xe9
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    expect(decodeBodyPart(buf, '8bit', 'iso-8859-1')).toBe('café');
  });

  it('decodes KOI8-R bytes when reported as 8bit charset=koi8-r', () => {
    const buf = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);
    expect(decodeBodyPart(buf, '8bit', 'koi8-r')).toBe('Привет');
  });

  it('falls back to QP for unknown encodings', () => {
    // unknown encoding "x-totally-made-up" — helper should not throw and
    // should still produce a string. With plain ASCII input, the QP fallback
    // is a no-op.
    const buf = Buffer.from('plain bytes');
    expect(decodeBodyPart(buf, 'x-made-up', null)).toBe('plain bytes');
  });

  it('returns empty string for empty Buffer', () => {
    expect(decodeBodyPart(Buffer.alloc(0), 'quoted-printable', 'utf-8')).toBe('');
  });

  it('falls back to utf-8 when charset is unknown', () => {
    const buf = Buffer.from('hello', 'latin1');
    expect(decodeBodyPart(buf, '7bit', 'x-fake-charset')).toBe('hello');
  });
});

describe('decodeBodyPart (string)', () => {
  it('returns already-decoded unicode string unchanged (regression guard)', () => {
    // Prior firstBodyPart ran libqp.decode on string values unconditionally,
    // which mangled already-decoded unicode (latin1 round-trip corruption).
    expect(decodeBodyPart('Привет', 'quoted-printable', 'utf-8')).toBe('Привет');
  });

  it('decodes QP-shaped ASCII string', () => {
    // imapflow may return a raw QP-encoded string for some servers; if it
    // contains =XX markers we still want to decode it.
    expect(decodeBodyPart('=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82', 'quoted-printable', 'utf-8')).toBe('Привет');
  });

  it('returns plain ASCII string unchanged', () => {
    expect(decodeBodyPart('Hello world', 'quoted-printable', 'utf-8')).toBe('Hello world');
  });
});

describe('decodeBodyPart (other)', () => {
  it('returns empty string for null / undefined / number', () => {
    expect(decodeBodyPart(null, null, null)).toBe('');
    expect(decodeBodyPart(undefined, null, null)).toBe('');
    expect(decodeBodyPart(42 as unknown, null, null)).toBe('');
  });
});

describe("Buffer encoding: 'latin1' vs deprecated 'binary'", () => {
  // The mime-decode pipeline uses 'latin1' to bridge Buffer ↔ string before
  // QP/base64 decoding. 'binary' is a deprecated Node.js alias for the same
  // codec; we keep this test so a future contributor who re-introduces
  // 'binary' (out of habit or lint auto-fix) sees the equivalence is what
  // the code relies on, not anything 'binary'-specific.
  it('round-trips arbitrary bytes identically under both encodings', () => {
    const bytes = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const viaLatin1 = Buffer.from(bytes.toString('latin1'), 'latin1');
    const viaBinary = Buffer.from(bytes.toString('binary'), 'binary');
    expect(viaLatin1.equals(bytes)).toBe(true);
    expect(viaBinary.equals(viaLatin1)).toBe(true);
  });

  it('produces matching QP decode through latin1 vs binary bridge', () => {
    const qp = Buffer.from('=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82', 'latin1');
    // The real code path: latin1 string -> libqp -> utf-8 string.
    const viaLatin1 = decodeBodyPart(qp, 'quoted-printable', 'utf-8');
    // Same payload reconstructed via the deprecated alias — must match.
    const sameBytes = Buffer.from(qp.toString('binary'), 'binary');
    const viaBinary = decodeBodyPart(sameBytes, 'quoted-printable', 'utf-8');
    expect(viaLatin1).toBe('Привет');
    expect(viaBinary).toBe(viaLatin1);
  });
});

describe('pickTextPart', () => {
  it('returns null for null / non-object input', () => {
    expect(pickTextPart(null)).toBeNull();
    expect(pickTextPart(undefined)).toBeNull();
    expect(pickTextPart('not an object')).toBeNull();
  });

  it('returns the single leaf for a flat text/plain message', () => {
    const bs = {
      type: 'text/plain',
      encoding: 'quoted-printable',
      parameters: { charset: 'utf-8' },
      part: '1',
    };
    expect(pickTextPart(bs)).toEqual({
      partId: '1',
      encoding: 'quoted-printable',
      charset: 'utf-8',
      type: 'text/plain',
    });
  });

  it('defaults partId to "1" when the leaf has no part field', () => {
    const bs = {
      type: 'text/html',
      encoding: 'base64',
      parameters: { charset: 'utf-8' },
    };
    expect(pickTextPart(bs)?.partId).toBe('1');
  });

  it('prefers text/plain over text/html in multipart/alternative', () => {
    const bs = {
      type: 'multipart/alternative',
      childNodes: [
        {
          type: 'text/html',
          encoding: 'base64',
          parameters: { charset: 'utf-8' },
          part: '2',
        },
        {
          type: 'text/plain',
          encoding: 'quoted-printable',
          parameters: { charset: 'utf-8' },
          part: '1',
        },
      ],
    };
    const picked = pickTextPart(bs);
    expect(picked?.type).toBe('text/plain');
    expect(picked?.partId).toBe('1');
  });

  it('falls back to text/html when no text/plain exists', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'text/html',
          encoding: 'base64',
          parameters: { charset: 'utf-8' },
          part: '1',
        },
        {
          type: 'image/jpeg',
          encoding: 'base64',
          parameters: {},
          part: '2',
        },
      ],
    };
    expect(pickTextPart(bs)?.type).toBe('text/html');
  });

  it('walks nested multipart trees', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            {
              type: 'text/html',
              encoding: 'base64',
              parameters: { charset: 'utf-8' },
              part: '1.2',
            },
            {
              type: 'text/plain',
              encoding: 'quoted-printable',
              parameters: { charset: 'utf-8' },
              part: '1.1',
            },
          ],
        },
        {
          type: 'application/pdf',
          encoding: 'base64',
          parameters: {},
          part: '2',
        },
      ],
    };
    const picked = pickTextPart(bs);
    expect(picked?.partId).toBe('1.1');
    expect(picked?.type).toBe('text/plain');
  });

  it('returns null when there is no text leaf (image-only message)', () => {
    const bs = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'image/jpeg', encoding: 'base64', parameters: {}, part: '1' },
        { type: 'image/png', encoding: 'base64', parameters: {}, part: '2' },
      ],
    };
    expect(pickTextPart(bs)).toBeNull();
  });

  it('defaults charset to utf-8 when parameters has no charset', () => {
    const bs = {
      type: 'text/plain',
      encoding: '7bit',
      parameters: null,
      part: '1',
    };
    expect(pickTextPart(bs)?.charset).toBe('utf-8');
  });
});
