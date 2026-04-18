import type { Handler } from './types.js';

export interface HandlerRegistry {
  register(handler: Handler): void;
  get(name: string): Handler | null;
  list(): Handler[];
}

export function createHandlerRegistry(): HandlerRegistry {
  const map = new Map<string, Handler>();
  return {
    register(handler) {
      if (map.has(handler.name)) {
        throw new Error(`Handler "${handler.name}" already registered`);
      }
      map.set(handler.name, handler);
    },
    get(name) {
      return map.get(name) ?? null;
    },
    list() {
      return [...map.values()];
    },
  };
}
