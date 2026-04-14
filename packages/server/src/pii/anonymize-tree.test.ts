import { describe, expect, it, vi } from 'vitest';
import type { PiiProxy, AnonymizeResult } from './proxy.js';
import { anonymizeJsonStringLeaves } from './anonymize-tree.js';

function makeMockProxy(): PiiProxy & {
  anonymize: ReturnType<typeof vi.fn>;
  deanonymize: ReturnType<typeof vi.fn>;
} {
  return {
    anonymize: vi.fn(async (text: string): Promise<AnonymizeResult> => {
      if (text.includes('a@b.c')) {
        return {
          text: text.replace('a@b.c', '<EMAIL:aaaa1111>'),
          entities: [{ type: 'EMAIL_ADDRESS', token: '<EMAIL:aaaa1111>', original: 'a@b.c' }],
        };
      }
      return { text, entities: [] };
    }),
    deanonymize: vi.fn(async (text: string) => text),
  };
}

describe('anonymizeJsonStringLeaves', () => {
  it('leaves non-string primitives untouched and does not call anonymize', async () => {
    const proxy = makeMockProxy();
    const input = { timestamp: 1776106975610, count: 42, active: true, nothing: null };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual(input);
    expect(result.entities).toEqual([]);
    expect(proxy.anonymize).not.toHaveBeenCalled();
  });

  it('regression: numeric timestamp stays a number while email string is masked', async () => {
    const proxy = makeMockProxy();
    const input = { timestamp: 1776106975610, text: 'email: a@b.c' };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({
      timestamp: 1776106975610,
      text: 'email: <EMAIL:aaaa1111>',
    });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('email: a@b.c');
    expect(result.entities).toEqual([
      { type: 'EMAIL_ADDRESS', token: '<EMAIL:aaaa1111>', original: 'a@b.c' },
    ]);
  });

  it('walks nested objects and arrays', async () => {
    const proxy = makeMockProxy();
    const input = { a: { b: [{ c: 'x' }, { c: 5 }] } };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({ a: { b: [{ c: 'x' }, { c: 5 }] } });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('x');
  });

  it('processes only string elements in arrays of primitives', async () => {
    const proxy = makeMockProxy();
    const input = [1, 2, 'text', true];

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual([1, 2, 'text', true]);
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('text');
  });

  it('skips empty strings without calling anonymize', async () => {
    const proxy = makeMockProxy();
    const input = { a: '', b: 'a@b.c' };

    const result = await anonymizeJsonStringLeaves(input, proxy);

    expect(result.value).toEqual({ a: '', b: '<EMAIL:aaaa1111>' });
    expect(proxy.anonymize).toHaveBeenCalledTimes(1);
    expect(proxy.anonymize).toHaveBeenCalledWith('a@b.c');
  });

  it('aggregates entities across multiple string leaves', async () => {
    const proxy = makeMockProxy();
    proxy.anonymize
      .mockImplementationOnce(async () => ({
        text: '<EMAIL:1>',
        entities: [{ type: 'EMAIL_ADDRESS', token: '<EMAIL:1>', original: 'a@x.c' }],
      }))
      .mockImplementationOnce(async () => ({
        text: '<PHONE:1>',
        entities: [{ type: 'PHONE_NUMBER', token: '<PHONE:1>', original: '+1' }],
      }));

    const result = await anonymizeJsonStringLeaves({ e: 'a@x.c', p: '+1' }, proxy);

    expect(result.value).toEqual({ e: '<EMAIL:1>', p: '<PHONE:1>' });
    expect(result.entities).toEqual([
      { type: 'EMAIL_ADDRESS', token: '<EMAIL:1>', original: 'a@x.c' },
      { type: 'PHONE_NUMBER', token: '<PHONE:1>', original: '+1' },
    ]);
  });

  it('handles top-level null without throwing', async () => {
    const proxy = makeMockProxy();

    const result = await anonymizeJsonStringLeaves(null, proxy);

    expect(result.value).toBeNull();
    expect(result.entities).toEqual([]);
    expect(proxy.anonymize).not.toHaveBeenCalled();
  });

  it('handles top-level string', async () => {
    const proxy = makeMockProxy();

    const result = await anonymizeJsonStringLeaves('email: a@b.c', proxy);

    expect(result.value).toBe('email: <EMAIL:aaaa1111>');
    expect(result.entities).toHaveLength(1);
  });
});
