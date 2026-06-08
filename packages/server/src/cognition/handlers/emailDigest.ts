import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import {
  inQuietHours,
  morningBriefPublishedToday,
  formatDigest,
  buildDigestMenu,
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
      // Cooldown only applies after a successful publish. Errors and skips
      // must be retry-able on the next tick — otherwise a transient Ollama /
      // Discord failure would silence the digest for the full cooldown window
      // while messages pile up.
      const publishedRecently =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        state.now - state.lastFiredAt < deps.cooldownMs;
      if (publishedRecently) return false;
      return true;
    },
    async run(ctx) {
      try {
        const totalPending = deps.store.countPendingUndelivered();
        const pending = deps.store.fetchPendingUndelivered(maxRows);
        if (pending.length === 0) return { skip: true, reason: 'no pending' };
        // Pass the true backlog count so header and "…ещё N писем" stay
        // honest when the store returned a capped slice.
        const { text, includedIds } = formatDigest(pending, totalPending);
        // Select-menu offering one action option per included email. Omitted
        // when empty so the digest stays a plain message in that edge case.
        const components = buildDigestMenu(pending, includedIds);
        // markDelivered runs only after the publish channel confirms delivery.
        // Marking here would silently drop rows when Discord DM fails — the
        // digest pushes nothing to the user yet countPendingUndelivered()
        // would drop below threshold on the next tick. Rows folded into the
        // "…ещё N писем" tail (outside includedIds) always stay pending.
        return {
          publish: true,
          content: text,
          ...(components.length > 0 ? { components } : {}),
          onPublished: () => deps.store.markDelivered(includedIds, Date.now()),
        };
      } catch (err) {
        return {
          error: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
