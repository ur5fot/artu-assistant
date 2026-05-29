import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import type { EmailSuppressionStore } from '../../emails/suppression-store.js';
import type { EmailFeedbackStore } from '../../emails/feedback-store.js';
import type { EmailPendingRow } from '../../emails/types.js';
import { buildUrgentEmailEmbed } from '../../channels/discord/embeds.js';
import { inQuietHours, MORNING_FALLBACK_HOUR } from './emailDigest.helpers.js';

// Sentinel stored in `email_pending.urgent_pinged_at` when a row was matched by
// an active suppression rule before any urgent ping went out. Distinct from
// NULL (never considered) and from a positive epoch ms (actually pinged) so
// that `/why` can later distinguish the three states.
export const SUPPRESSED_PING_SENTINEL = -1;

// Observability — manual review queries (run via sqlite3 on r2.db):
//
// -- Urgent pings published in the last 7 days
// SELECT COUNT(*) FROM email_pending
// WHERE urgent_pinged_at IS NOT NULL
//   AND urgent_pinged_at > (strftime('%s','now') - 7*86400) * 1000;
//
// -- Urgent pings per day (last 14 days)
// SELECT date(urgent_pinged_at / 1000, 'unixepoch') AS day, COUNT(*)
// FROM email_pending
// WHERE urgent_pinged_at IS NOT NULL
// GROUP BY day ORDER BY day DESC LIMIT 14;
//
// -- Candidates for false positives: most recent urgent pings (manual triage
// -- until iter 4's implicit feedback work lands).
// SELECT id, from_addr, subject, urgent_pinged_at
// FROM email_pending
// WHERE urgent_pinged_at IS NOT NULL
// ORDER BY urgent_pinged_at DESC LIMIT 20;

const SNIPPET_MAX = 200;

interface Deps {
  store: EmailStore;
  suppressionStore: EmailSuppressionStore;
  // Optional implicit-feedback collector. When present (feature enabled in
  // index.ts), a feedback row is recorded for every *actually pinged* urgent
  // email so the outcome (replied/read/ignored) can be resolved later. Absent
  // → no-op, like the other optional stores. The suppression-sentinel (-1)
  // path never reaches here, so demoted rows never get a feedback row.
  feedbackStore?: EmailFeedbackStore;
  tz: string;
  quietStart: number;
}

// Drain suppressed candidates and return the first unsuppressed urgent row, or
// null when nothing remains. Called from both `trigger` and `run` because they
// execute at different instants — a new suppression rule (or an out-of-order
// older urgent row) can appear between the two, and `run` must not publish a
// row that's now suppressed. Each iteration either exhausts the candidate set,
// finds a row no rule matches, or marks one suppressed row with the sentinel,
// shrinking the set monotonically.
function drainAndFindUrgent(deps: Deps, now: number): EmailPendingRow | null {
  while (true) {
    const row = deps.store.findUnpingedUrgent();
    if (row === null) return null;
    const rule = deps.suppressionStore.findActiveMatch(row.from_addr, row.subject, now);
    if (rule === null) return row;
    // Mark with sentinel so this row is excluded from future urgent candidate
    // sets (findUnpingedUrgent filters `IS NULL`) and so /why can later report
    // "suppressed by rule X" instead of "pinged".
    deps.store.markUrgentPinged(row.id, SUPPRESSED_PING_SENTINEL);
  }
}

export function createEmailUrgentHandler(deps: Deps): Handler {
  return {
    name: 'emailUrgent',
    async trigger(state) {
      // Pass MORNING_FALLBACK_HOUR so the overnight window holds through
      // morning release. Without this the handler would ping at 02:00 —
      // inQuietHours alone only suppresses quietStart..23:59.
      if (inQuietHours(state.now, deps.quietStart, deps.tz, MORNING_FALLBACK_HOUR)) return false;
      return drainAndFindUrgent(deps, state.now) !== null;
    },
    async run(ctx) {
      // Re-run the drain in case a suppression rule was created between
      // trigger and run, or an out-of-order older urgent row appeared. Without
      // this, a row matching a freshly-created rule could still be published.
      const row = drainAndFindUrgent(deps, ctx.firedAt);
      if (row === null) return { skip: true, reason: 'no unpinged urgent row' };
      // Collapse internal whitespace and trim — IMAP-decoded headers
      // (from name, subject) and snippets can contain raw \n / \r / \t
      // that would break the expected 3-line Discord layout.
      const from = row.from_addr.replace(/\s+/g, ' ').trim();
      const subject = row.subject.replace(/\s+/g, ' ').trim();
      const snippet = row.snippet.replace(/\s+/g, ' ').trim();
      const truncated =
        snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX - 1) + '…' : snippet;
      const content = `🚨 ${from}\n${subject}\n${truncated}`;
      const { embed, components } = buildUrgentEmailEmbed(row);
      return {
        publish: true,
        content,
        embed,
        components,
        onPublished: () => {
          const pingedAt = Date.now();
          deps.store.markUrgentPinged(row.id, pingedAt);
          // Record the ping for implicit-feedback outcome tracking. Same epoch
          // as the marker so the "ignored" timer and the email_pending state
          // agree. No-op when feedback is disabled (store absent).
          deps.feedbackStore?.recordPinged(row.id, pingedAt);
        },
      };
    },
  };
}
