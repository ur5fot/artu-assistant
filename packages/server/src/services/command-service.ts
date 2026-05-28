import type Database from 'better-sqlite3';
import type { ReminderService } from './reminder-service.js';
import type { PermissionService } from './permission-service.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderRow } from '../reminders/store.js';
import type { EmailStore } from '../emails/store.js';
import type { EmailSentLog } from '../emails/sent-log.js';
import type {
  EmailSuppressionStore,
  SuppressionRule,
} from '../emails/suppression-store.js';
import type { EmailPendingRow } from '../emails/types.js';

export type WhyEmailUrgentResult =
  | { kind: 'not_configured' }
  | { kind: 'not_found'; id: number }
  | { kind: 'no_recent_urgent' }
  | { kind: 'suppressed'; row: EmailPendingRow; matchedRule: SuppressionRule | null }
  | {
      kind: 'urgent';
      row: EmailPendingRow;
      history: {
        pendings: number;
        sent: number;
        cancelled: number;
        error: number;
      };
      activeRule: SuppressionRule | null;
    };

export interface CommandService {
  clearHistory(): { deleted: number };
  status(): {
    model: string;
    uptimeSeconds: number;
    activeReminders: number;
    pendingPermissions: number;
  };
  listReminders(): ReminderRow[];
  listMemory(query?: string): Promise<{
    available: boolean;
    entries: Array<{ text: string; timestamp: number }>;
  }>;
  listPermissionRules(): Array<{ toolName: string; allowed: boolean }>;
  revokePermissionRule(
    toolName: string,
  ): { ok: true } | { ok: false; reason: 'not_found' };
  whyEmailUrgent(params: { id?: number; now?: number }): WhyEmailUrgentResult;
}

interface Deps {
  db: Database.Database;
  reminderService: ReminderService;
  permissionService: PermissionService;
  memoryService: MemoryService | null;
  pendingConfirmsCount?: () => number;
  pendingPlanReviewsCount?: () => number;
  startedAt?: number;
  /** Email pending store — read by `/why` to look up the row and prior pings
   *  from the same sender. Optional so existing call sites without email
   *  wiring keep working; `/why` returns `not_configured` when absent. */
  emailStore?: EmailStore;
  /** Sent log — read by `/why` to count sent/cancelled/error per sender. */
  emailSentLog?: EmailSentLog;
  /** Suppression rules — `/why` shows the matching rule for suppressed rows
   *  and any active rule that would suppress a normal urgent row. */
  emailSuppressionStore?: EmailSuppressionStore;
}

const HISTORY_WINDOW_DAYS = 7;
const SUPPRESSED_PING_SENTINEL = -1;

export function createCommandService(deps: Deps): CommandService {
  const {
    db,
    reminderService,
    memoryService,
    pendingConfirmsCount = () => 0,
    pendingPlanReviewsCount = () => 0,
    startedAt = Date.now(),
    emailStore,
    emailSentLog,
    emailSuppressionStore,
  } = deps;

  return {
    clearHistory() {
      const result = db.prepare('DELETE FROM chat_messages').run();
      return { deleted: Number(result.changes ?? 0) };
    },
    status() {
      // Read at call time — matches AI layer's lazy env resolution (see
      // ai/claude.ts) so `/status` reflects the model currently in use.
      const localMode = (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
      const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
      const claudeModel = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
      const model = localMode ? `${ollamaModel} → ${claudeModel}` : claudeModel;
      return {
        model,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        activeReminders: reminderService.list().length,
        pendingPermissions: pendingConfirmsCount() + pendingPlanReviewsCount(),
      };
    },
    listReminders() {
      return reminderService.list();
    },
    async listMemory(query) {
      if (!memoryService) return { available: false, entries: [] };
      if (query) {
        const hits = await memoryService.search({ query, limit: 10 });
        return {
          available: true,
          entries: hits.map((h) => ({ text: h.text, timestamp: h.timestamp })),
        };
      }
      const facts = await memoryService.getActiveFacts();
      return {
        available: true,
        entries: facts.map((f) => ({
          text: `${f.key}: ${f.value}`,
          timestamp: f.lastMentionedAt,
        })),
      };
    },
    listPermissionRules() {
      const rows = db
        .prepare('SELECT tool_name, allowed FROM permission_rules ORDER BY tool_name')
        .all() as Array<{ tool_name: string; allowed: number }>;
      return rows.map((r) => ({ toolName: r.tool_name, allowed: r.allowed === 1 }));
    },
    revokePermissionRule(toolName: string) {
      const result = db
        .prepare('DELETE FROM permission_rules WHERE tool_name = ?')
        .run(toolName);
      return result.changes > 0
        ? ({ ok: true } as const)
        : ({ ok: false, reason: 'not_found' } as const);
    },
    whyEmailUrgent({ id, now: nowOverride }) {
      if (!emailStore || !emailSentLog || !emailSuppressionStore) {
        return { kind: 'not_configured' } as const;
      }
      const now = nowOverride ?? Date.now();
      const row = typeof id === 'number'
        ? emailStore.findByPendingId(id)
        : emailStore.findMostRecentUrgent();
      if (!row) {
        return typeof id === 'number'
          ? ({ kind: 'not_found', id } as const)
          : ({ kind: 'no_recent_urgent' } as const);
      }
      if (row.urgent_pinged_at === SUPPRESSED_PING_SENTINEL) {
        // Suppressed: surface the rule that *currently* matches this row.
        // The original suppressing rule may have expired since; we show the
        // active one to keep the answer aligned with present-day state.
        const matchedRule = emailSuppressionStore.findActiveMatch(
          row.from_addr,
          row.subject,
          now,
        );
        return { kind: 'suppressed', row, matchedRule } as const;
      }
      const sinceMs = now - HISTORY_WINDOW_DAYS * 86_400_000;
      const history = {
        pendings: emailStore.countPendingFromSender(row.from_addr, sinceMs),
        sent: emailSentLog.countBySender(row.from_addr, HISTORY_WINDOW_DAYS, 'sent'),
        cancelled: emailSentLog.countBySender(row.from_addr, HISTORY_WINDOW_DAYS, 'cancelled'),
        error: emailSentLog.countBySender(row.from_addr, HISTORY_WINDOW_DAYS, 'error'),
      };
      const activeRule = emailSuppressionStore.findActiveMatch(
        row.from_addr,
        row.subject,
        now,
      );
      return { kind: 'urgent', row, history, activeRule } as const;
    },
  };
}
