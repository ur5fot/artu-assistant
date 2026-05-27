import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import { inQuietHours } from './emailDigest.helpers.js';

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
  tz: string;
  quietStart: number;
}

export function createEmailUrgentHandler(deps: Deps): Handler {
  return {
    name: 'emailUrgent',
    async trigger(state) {
      if (inQuietHours(state.now, deps.quietStart, deps.tz)) return false;
      return deps.store.findUnpingedUrgent() !== null;
    },
    async run() {
      // Defensive re-fetch: trigger and run execute at different instants, so
      // another tick (or a manual UPDATE) could have marked the row between
      // the trigger check and now.
      const row = deps.store.findUnpingedUrgent();
      if (row === null) return { skip: true, reason: 'no unpinged urgent row' };
      const snippet = row.snippet ?? '';
      const truncated =
        snippet.length > SNIPPET_MAX ? snippet.slice(0, SNIPPET_MAX - 1) + '…' : snippet;
      const content = `🚨 ${row.from_addr}\n${row.subject}\n${truncated}`;
      return {
        publish: true,
        content,
        onPublished: () => deps.store.markUrgentPinged(row.id, Date.now()),
      };
    },
  };
}
