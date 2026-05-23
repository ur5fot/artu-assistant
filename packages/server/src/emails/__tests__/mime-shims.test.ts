import { describe, it, expect } from 'vitest';
import libqp from 'libqp';
import libmime from 'libmime';
import libbase64 from 'libbase64';
import iconv from 'iconv-lite';

// Guard against transitive deps disappearing after a package-lock churn.
// libqp/libmime/libbase64/iconv-lite are not direct dependencies — they ride in
// via imapflow. If imapflow ever drops them, MIME decoding silently breaks;
// this test fails loudly instead.
describe('mime shims (libqp, libmime, libbase64, iconv-lite)', () => {
  it('libqp exposes decode()', () => {
    expect(typeof libqp.decode).toBe('function');
  });

  it('libmime exposes decodeWords()', () => {
    expect(typeof libmime.decodeWords).toBe('function');
  });

  it('libbase64 exposes decode()', () => {
    expect(typeof libbase64.decode).toBe('function');
  });

  it('iconv-lite exposes decode() and encodingExists()', () => {
    expect(typeof iconv.decode).toBe('function');
    expect(typeof iconv.encodingExists).toBe('function');
  });

  it('libqp.decode round-trips a simple QP string', () => {
    const out = libqp.decode('=D0=9F=D1=80=D0=B8=D0=B2=D0=B5=D1=82');
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString('utf-8')).toBe('Привет');
  });

  it('libmime.decodeWords decodes an RFC2047 encoded-word', () => {
    const out = libmime.decodeWords('=?utf-8?Q?Hello?=');
    expect(out).toBe('Hello');
  });

  it('iconv-lite decodes a KOI8-R buffer', () => {
    const buf = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]);
    expect(iconv.decode(buf, 'koi8-r')).toBe('Привет');
  });
});
