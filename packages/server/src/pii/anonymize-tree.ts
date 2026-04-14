import type { PiiProxy, AnonymizeResult } from './proxy.js';

export interface TreeAnonymizeResult {
  value: unknown;
  entities: AnonymizeResult['entities'];
}

/**
 * Recursively walks a JSON-like value and anonymizes only string leaves via
 * the given PiiProxy. Numbers, booleans, null, and undefined are returned
 * untouched so that numeric fields (timestamps, scores, ids) never reach
 * Presidio's regex recognizers — which would otherwise mis-classify large
 * integers as CREDIT_CARD / PHONE_NUMBER.
 */
export async function anonymizeJsonStringLeaves(
  value: unknown,
  piiProxy: PiiProxy,
): Promise<TreeAnonymizeResult> {
  const entities: AnonymizeResult['entities'] = [];

  async function walk(node: unknown): Promise<unknown> {
    if (typeof node === 'string') {
      if (node.length === 0) return node;
      const anon = await piiProxy.anonymize(node);
      entities.push(...anon.entities);
      return anon.text;
    }
    if (Array.isArray(node)) {
      const out: unknown[] = [];
      for (const item of node) {
        out.push(await walk(item));
      }
      return out;
    }
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = await walk(v);
      }
      return out;
    }
    return node;
  }

  const walked = await walk(value);
  return { value: walked, entities };
}
