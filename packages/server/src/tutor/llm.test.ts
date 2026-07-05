import { describe, it, expect } from 'vitest';
import { extractJson, isNonEmptyString } from './llm.js';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a ```json fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in a plain ``` fence', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON surrounded by prose', () => {
    expect(extractJson('Here you go: {"a":1} — hope that helps!')).toEqual({
      a: 1,
    });
  });

  it('throws when there are no braces at all', () => {
    expect(() => extractJson('no json here')).toThrow('no JSON object found');
  });

  it('throws on an empty string', () => {
    expect(() => extractJson('')).toThrow('no JSON object found');
  });

  it('throws when only an opening brace is present', () => {
    expect(() => extractJson('{ "a": 1')).toThrow('no JSON object found');
  });

  it('throws when only a closing brace is present', () => {
    expect(() => extractJson('"a": 1 }')).toThrow('no JSON object found');
  });

  it('throws when the closing brace precedes the opening one', () => {
    expect(() => extractJson('} some text {')).toThrow('no JSON object found');
  });

  it('grabs an incidental brace pair before the real payload and fails to parse it as JSON', () => {
    // A stray `{...}` earlier in the prose is not valid JSON on its own —
    // extractJson takes the first `{` to the last `}`, which here spans both
    // the incidental pair and the real payload, and that combined slice isn't
    // valid JSON either, so JSON.parse throws (as opposed to silently
    // returning a wrong-but-parseable object).
    const text = 'note: {not json} then the real one {"a":1}';
    expect(() => extractJson(text)).toThrow();
  });

  it('picks the first fenced block when multiple are present', () => {
    const text = '```json\n{"a":1}\n```\nand also\n```json\n{"b":2}\n```';
    expect(extractJson(text)).toEqual({ a: 1 });
  });
});

describe('isNonEmptyString', () => {
  it('accepts a non-empty string', () => {
    expect(isNonEmptyString('hello')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isNonEmptyString('   ')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isNonEmptyString(1)).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
  });
});
