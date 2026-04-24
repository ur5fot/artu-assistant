import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import {
  inQuietHours,
  morningBriefPublishedToday,
  formatDigest,
} from './emailDigest.helpers.js';

interface Deps {
  store: EmailStore;
  tz: string;
  threshold: number;
  cooldownMs: number;
  quietStart: number;
  maxRows?: number;
}

export function createEmailDigestHandler(deps: Deps): Handler {
  const maxRows = deps.maxRows ?? 50;
  return {
    name: 'emailDigest',
    async trigger(state, ctx) {
      if (deps.store.countPendingUndelivered() < deps.threshold) return false;
      if (inQuietHours(state.now, deps.quietStart, deps.tz)) return false;
      if (!morningBriefPublishedToday(ctx.db, state.now, deps.tz)) return false;
      if (state.lastFiredAt && state.now - state.lastFiredAt < deps.cooldownMs) return false;
      return true;
    },
    async run(ctx) {
      try {
        const pending = deps.store.fetchPendingUndelivered(maxRows);
        if (pending.length === 0) return { skip: true, reason: 'no pending' };
        const content = formatDigest(pending);
        deps.store.markDelivered(pending.map((r) => r.id), ctx.firedAt);
        return { publish: true, content };
      } catch (err) {
        return {
          error: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
