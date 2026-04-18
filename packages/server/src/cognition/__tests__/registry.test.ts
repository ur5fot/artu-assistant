import { describe, it, expect } from 'vitest';
import { createHandlerRegistry } from '../registry.js';
import type { Handler } from '../types.js';

const noop: Handler = {
  name: 'x',
  trigger: () => false,
  run: async () => ({ skip: true, reason: '' }),
};

describe('HandlerRegistry', () => {
  it('register + get + list', () => {
    const reg = createHandlerRegistry();
    reg.register({ ...noop, name: 'a' });
    reg.register({ ...noop, name: 'b' });
    expect(reg.get('a')?.name).toBe('a');
    expect(reg.list().map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('duplicate name throws', () => {
    const reg = createHandlerRegistry();
    reg.register({ ...noop, name: 'a' });
    expect(() => reg.register({ ...noop, name: 'a' })).toThrow(/already registered/);
  });

  it('get returns null for unknown', () => {
    const reg = createHandlerRegistry();
    expect(reg.get('nope')).toBeNull();
  });
});
