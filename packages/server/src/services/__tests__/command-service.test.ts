import { describe, it, expect, vi } from 'vitest';
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

  it('status: returns model, reminder count, pending count, uptime seconds', () => {
    const svc = createCommandService({
      db: makeDb() as any,
      reminderService: { list: vi.fn().mockReturnValue([{ id: 1 } as any]) } as unknown as ReminderService,
      permissionService: { hasPending: vi.fn() } as unknown as PermissionService,
      memoryService: null,
      pendingConfirmsCount: () => 2,
      pendingPlanReviewsCount: () => 1,
      modelName: 'claude-opus-4-7',
      startedAt: Date.now() - 5000,
    });
    const s = svc.status();
    expect(s.model).toBe('claude-opus-4-7');
    expect(s.activeReminders).toBe(1);
    expect(s.pendingPermissions).toBe(3);
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(4);
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
