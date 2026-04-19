import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandService } from '../command-service.js';
import type { ReminderService } from '../reminder-service.js';
import type { PermissionService } from '../permission-service.js';
import type { MemoryService } from '../../memory/service.js';

function makeDb() {
  const run = vi.fn().mockReturnValue({ changes: 3 });
  return {
    prepare: vi.fn().mockReturnValue({ run }),
    _run: run,
  };
}

describe('command-service', () => {
  it('clearHistory: deletes all chat_messages, returns count', () => {
    const db = makeDb();
    const svc = createCommandService({
      db: db as any,
      reminderService: { list: vi.fn().mockReturnValue([]) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn().mockReturnValue(false) } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.clearHistory()).toEqual({ deleted: 3 });
    expect(db.prepare).toHaveBeenCalledWith('DELETE FROM chat_messages');
    expect(db._run).toHaveBeenCalled();
  });

  it('listReminders: delegates to reminderService.list', () => {
    const rows = [{ id: 1, text: 'buy milk', next_fire_at_ms: 1000 } as any];
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn().mockReturnValue(rows) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.listReminders()).toBe(rows);
  });

  describe('status', () => {
    const originalLocal = process.env.LOCAL_LLM_MODE;
    const originalClaude = process.env.CLAUDE_MODEL;
    const originalOllama = process.env.OLLAMA_MODEL;
    afterEach(() => {
      for (const [k, v] of [
        ['LOCAL_LLM_MODE', originalLocal],
        ['CLAUDE_MODEL', originalClaude],
        ['OLLAMA_MODEL', originalOllama],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function svc(overrides: Partial<Parameters<typeof createCommandService>[0]> = {}) {
      return createCommandService({
        db: makeDb() as any,
        reminderService: { list: vi.fn().mockReturnValue([{ id: 1 } as any]) } as unknown as ReminderService,
        permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
        memoryService: null,
        pendingConfirmsCount: () => 2,
        pendingPlanReviewsCount: () => 1,
        startedAt: Date.now() - 5000,
        ...overrides,
      });
    }

    it('returns ollama→claude model string when LOCAL_LLM_MODE=enabled', () => {
      process.env.LOCAL_LLM_MODE = 'enabled';
      process.env.OLLAMA_MODEL = 'qwen2.5:7b';
      process.env.CLAUDE_MODEL = 'claude-haiku-4-5';
      const s = svc().status();
      expect(s.model).toBe('qwen2.5:7b → claude-haiku-4-5');
      expect(s.activeReminders).toBe(1);
      expect(s.pendingPermissions).toBe(3);
      expect(s.uptimeSeconds).toBeGreaterThanOrEqual(4);
    });

    it('returns only claude model when LOCAL_LLM_MODE=disabled', () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      process.env.CLAUDE_MODEL = 'claude-haiku-4-5';
      delete process.env.OLLAMA_MODEL;
      expect(svc().status().model).toBe('claude-haiku-4-5');
    });

    it('defaults to enabled mode when LOCAL_LLM_MODE unset', () => {
      delete process.env.LOCAL_LLM_MODE;
      process.env.OLLAMA_MODEL = 'qwen2.5:7b';
      process.env.CLAUDE_MODEL = 'claude-sonnet-4-6';
      expect(svc().status().model).toBe('qwen2.5:7b → claude-sonnet-4-6');
    });

    it('falls back to defaults when both model env vars unset', () => {
      process.env.LOCAL_LLM_MODE = 'enabled';
      delete process.env.OLLAMA_MODEL;
      delete process.env.CLAUDE_MODEL;
      expect(svc().status().model).toBe('qwen2.5:7b → claude-sonnet-4-6');
    });

    it('reads env at call time, not construction time', () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      process.env.CLAUDE_MODEL = 'first';
      const s = svc();
      expect(s.status().model).toBe('first');
      process.env.CLAUDE_MODEL = 'second';
      expect(s.status().model).toBe('second');
    });
  });

  it('listMemory: returns unavailable when memory service is null', async () => {
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    const res = await svc.listMemory();
    expect(res).toEqual({ available: false, entries: [] });
  });

  it('listMemory without query: maps active facts to entries', async () => {
    const memoryService = {
      getActiveFacts: vi.fn().mockResolvedValue([
        { key: 'likes', value: 'tea', lastMentionedAt: 1000 },
        { key: 'city', value: 'kyiv', lastMentionedAt: 2000 },
      ]),
      search: vi.fn(),
    } as unknown as MemoryService;
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService,
    });
    const res = await svc.listMemory();
    expect(res.available).toBe(true);
    expect(res.entries).toEqual([
      { text: 'likes: tea', timestamp: 1000 },
      { text: 'city: kyiv', timestamp: 2000 },
    ]);
  });

  it('listMemory with query: maps search hits to entries', async () => {
    const memoryService = {
      getActiveFacts: vi.fn(),
      search: vi.fn().mockResolvedValue([
        { text: 'bought milk', kind: 'user_msg', score: 0.9, timestamp: 500 },
        { text: 'visited mom', kind: 'fact', score: 0.7, timestamp: 700 },
      ]),
    } as unknown as MemoryService;
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService,
    });
    const res = await svc.listMemory('milk');
    expect(memoryService.search).toHaveBeenCalledWith({ query: 'milk', limit: 10 });
    expect(res.available).toBe(true);
    expect(res.entries).toEqual([
      { text: 'bought milk', timestamp: 500 },
      { text: 'visited mom', timestamp: 700 },
    ]);
  });
});

describe('command-service — permission rules', () => {
  it('listPermissionRules: delegates to db', () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        all: vi.fn().mockReturnValue([
          { tool_name: 'a', allowed: 1 },
          { tool_name: 'b', allowed: 0 },
        ]),
      }),
    };
    const svc = createCommandService({
      db: db as any,
      reminderService: { list: vi.fn().mockReturnValue([]) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.listPermissionRules()).toEqual([
      { toolName: 'a', allowed: true },
      { toolName: 'b', allowed: false },
    ]);
  });

  it('revokePermissionRule: returns ok when rule exists', () => {
    const run = vi.fn().mockReturnValue({ changes: 1 });
    const db = { prepare: vi.fn().mockReturnValue({ run, all: vi.fn() }) };
    const svc = createCommandService({
      db: db as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.revokePermissionRule('foo')).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('foo');
  });

  it('revokePermissionRule: returns not_found when rule absent', () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        all: vi.fn(),
      }),
    };
    const svc = createCommandService({
      db: db as any,
      reminderService: { list: vi.fn() } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
    });
    expect(svc.revokePermissionRule('ghost')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
