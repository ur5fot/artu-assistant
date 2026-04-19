import type Database from 'better-sqlite3';
import type { ReminderService } from './reminder-service.js';
import type { PermissionService } from './permission-service.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderRow } from '../reminders/store.js';

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
}

interface Deps {
  db: Database.Database;
  reminderService: ReminderService;
  permissionService: PermissionService;
  memoryService: MemoryService | null;
  pendingConfirmsCount?: () => number;
  pendingPlanReviewsCount?: () => number;
  startedAt?: number;
}

export function createCommandService(deps: Deps): CommandService {
  const {
    db,
    reminderService,
    memoryService,
    pendingConfirmsCount = () => 0,
    pendingPlanReviewsCount = () => 0,
    startedAt = Date.now(),
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
  };
}
