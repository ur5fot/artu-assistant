import { parseFromAddress } from './address.js';
import type { EmailFeedbackStore } from './feedback-store.js';
import type { EmailSuppressionStore } from './suppression-store.js';

export interface FeedbackScorerConfig {
  /** Lookback window for counting a sender's recent outcomes. */
  lookbackMs: number;
  /** Negative outcomes (`ignored` + `read`) within the lookback that trigger
   *  an auto suppression. */
  suppressAfter: number;
  /** TTL for an auto-created suppression rule. */
  suppressTtlDays: number;
}

export type FeedbackAction = 'suppressed' | 'cleared' | 'none';

export interface EvaluateResult {
  action: FeedbackAction;
  /** Id of a newly inserted auto-suppression rule (`suppressed`). */
  ruleId?: number;
  /** Ids of auto-suppression rules removed because trust was re-earned
   *  (`cleared`). */
  clearedRuleIds?: number[];
}

/** Provenance tag for rules created by this scorer; never cleared/created on
 *  manually-authored (`discord_button`) rules. */
export const AUTO_FEEDBACK_VIA = 'auto_feedback';

/** Remove every active auto-feedback sender rule for `sender`. Manual rules
 *  (any other `created_via`) are left untouched. */
function clearAutoRules(
  suppressionStore: EmailSuppressionStore,
  sender: string,
  now: number,
): number[] {
  const bare = parseFromAddress(sender);
  const cleared: number[] = [];
  for (const rule of suppressionStore.listActive(now)) {
    if (
      rule.rule_type === 'sender' &&
      rule.created_via === AUTO_FEEDBACK_VIA &&
      rule.pattern === bare
    ) {
      if (suppressionStore.deleteRule(rule.id)) cleared.push(rule.id);
    }
  }
  return cleared;
}

/** Downgrade-only feedback action for one sender, run after an outcome is
 *  finalized.
 *
 *  - A `replied` outcome in the lookback re-earns trust: any active
 *    auto-feedback rule for the sender is cleared (and we never suppress).
 *  - Otherwise, once the sender's negative outcomes (`ignored` + `read`) reach
 *    `suppressAfter` and no rule is already active, insert a TTL'd
 *    `auto_feedback` sender suppression. The existing `findActiveMatch` path in
 *    `emailUrgent.ts` then demotes that sender's future urgent pings to the
 *    digest — no new demotion code needed.
 */
export function evaluateSender(
  sender: string,
  store: EmailFeedbackStore,
  suppressionStore: EmailSuppressionStore,
  cfg: FeedbackScorerConfig,
  now: number,
): EvaluateResult {
  const counts = store.recentOutcomesBySender(sender, cfg.lookbackMs, now);

  // Reply wins: trust re-earned → drop any auto suppression for the sender.
  if (counts.replied > 0) {
    const clearedRuleIds = clearAutoRules(suppressionStore, sender, now);
    return clearedRuleIds.length > 0 ? { action: 'cleared', clearedRuleIds } : { action: 'none' };
  }

  const negative = counts.ignored + counts.read;
  if (negative >= cfg.suppressAfter) {
    // An active rule (manual or a prior auto one) already demotes this sender —
    // don't stack duplicates. Empty subject can't match a subject rule.
    if (suppressionStore.findActiveMatch(sender, '', now)) return { action: 'none' };
    const inserted = suppressionStore.insertRule({
      rule_type: 'sender',
      pattern: sender,
      ttl_days: cfg.suppressTtlDays,
      created_via: AUTO_FEEDBACK_VIA,
    });
    return { action: 'suppressed', ruleId: inserted.id };
  }

  return { action: 'none' };
}
