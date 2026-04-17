# Discord Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four Phase 2 features to the Discord bot — live tool-call embeds with state transitions, `.diff` attachments for `code_task`, `🔵 claude` prefix on escalation, and `/permissions` slash command with revoke buttons.

**Architecture:** All four features extend existing Discord surfaces. Tool-call embeds and escalation marker extend the bot's `onEvent` handler (`bot.ts`) to listen for `tool_call_start` / `tool_progress` / `tool_call_result` / `assistant_source` SSE events that the server already emits but the bot currently ignores. Diff attachments piggyback on the `tool_call_result` handler when the tool is `code_task` and `data.fullDiff` is present. `/permissions` reuses the Phase 1 interaction router and adds two new service methods on `CommandService` backed by two new SQLite helpers.

**Tech Stack:** TypeScript, Node.js 22, vitest, discord.js 14, better-sqlite3.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `packages/server/src/channels/discord/tool-embeds.ts` | Pure factories: `buildToolCallEmbed(state, toolCall, extras?)`, `buildDiffAttachment(data, callId)`, and the `SILENT_TOOLS` constant. |
| `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts` | Unit tests for tool-embed factories. |

### Modified files

| File | Change |
|---|---|
| `packages/server/src/db.ts` | Add `listPermissionRules()` and `deletePermissionRule(toolName)`. |
| `packages/server/src/services/command-service.ts` | Add `listPermissionRules()` and `revokePermissionRule(toolName)` methods. |
| `packages/server/src/services/__tests__/command-service.test.ts` | Tests for the two new methods. |
| `packages/server/src/channels/discord/embeds.ts` | Add `buildPermissionsListReply(rules)`. |
| `packages/server/src/channels/discord/__tests__/embeds.test.ts` | Tests for `buildPermissionsListReply`. |
| `packages/server/src/channels/discord/slash-commands.ts` | Register `/permissions`. |
| `packages/server/src/channels/discord/interactions.ts` | `/permissions` slash handler + `perm_rule:revoke:*` button handler. |
| `packages/server/src/channels/discord/__tests__/interactions.test.ts` | Tests for `/permissions` slash and revoke button. |
| `packages/server/src/channels/discord/bot.ts` | Handle `tool_call_start` / `tool_progress` / `tool_call_result` / `assistant_source`; 800 ms progress debounce; `🔵 claude` prefix on escalated flush; `.diff` attachment on `code_task` result. |
| `packages/server/src/channels/discord/__tests__/bot.test.ts` | Tests for tool-embed lifecycle, SILENT_TOOLS skip, diff attachment, escalation prefix. |

---

## Conventions

- **Tests first.** Every task starts with a failing test.
- **Run tests per task:** `npx vitest run --root packages/server <path>`
- **Commit after each task.** Conventional-ish messages (match existing repo style, e.g. `feat(discord): …`, `feat(services): …`, `fix(discord): …`).
- **ESM imports with `.js` extensions.** Matches repo convention.
- **discord.js 14.26.x.** Use `EmbedBuilder`, `ButtonBuilder`, `ActionRowBuilder`, `SlashCommandBuilder`, `MessageFlags`, `AttachmentBuilder`.

---

## Task 1: DB — `listPermissionRules` + `deletePermissionRule`

**Files:**
- Modify: `packages/server/src/db.ts`
- Modify: `packages/server/src/db.test.ts`

- [x] **Step 1: Write failing tests**

Append to `packages/server/src/db.test.ts`:

```ts
import { listPermissionRules, deletePermissionRule, savePermissionRule, clearPermissionRules } from './db.js';

describe('permission rules CRUD', () => {
  beforeEach(() => {
    clearPermissionRules();
  });

  it('listPermissionRules: empty when none saved', () => {
    expect(listPermissionRules()).toEqual([]);
  });

  it('listPermissionRules: returns rules sorted by tool_name', () => {
    savePermissionRule('zzz', true);
    savePermissionRule('aaa', false);
    savePermissionRule('mmm', true);
    expect(listPermissionRules()).toEqual([
      { toolName: 'aaa', allowed: false },
      { toolName: 'mmm', allowed: true },
      { toolName: 'zzz', allowed: true },
    ]);
  });

  it('deletePermissionRule: returns true when rule exists', () => {
    savePermissionRule('foo', true);
    expect(deletePermissionRule('foo')).toBe(true);
    expect(listPermissionRules()).toEqual([]);
  });

  it('deletePermissionRule: returns false when rule does not exist', () => {
    expect(deletePermissionRule('ghost')).toBe(false);
  });
});
```

Imports at the top of `db.test.ts` may already exist — only add the new names (`listPermissionRules`, `deletePermissionRule`) and reuse existing ones.

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/db.test.ts
```

Expected: FAIL with `listPermissionRules is not a function` (or similar).

- [x] **Step 3: Implement**

Edit `packages/server/src/db.ts`. After the existing `clearPermissionRules` function:

```ts
export function listPermissionRules(): Array<{ toolName: string; allowed: boolean }> {
  const d = getDb();
  const rows = d
    .prepare('SELECT tool_name, allowed FROM permission_rules ORDER BY tool_name')
    .all() as Array<{ tool_name: string; allowed: number }>;
  return rows.map((r) => ({ toolName: r.tool_name, allowed: r.allowed === 1 }));
}

export function deletePermissionRule(toolName: string): boolean {
  const d = getDb();
  const result = d
    .prepare('DELETE FROM permission_rules WHERE tool_name = ?')
    .run(toolName);
  return result.changes > 0;
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run --root packages/server packages/server/src/db.test.ts
```

Expected: all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/db.test.ts
git commit -m "feat(db): add listPermissionRules and deletePermissionRule"
```

---

## Task 2: `command-service` — `listPermissionRules` + `revokePermissionRule`

**Files:**
- Modify: `packages/server/src/services/command-service.ts`
- Modify: `packages/server/src/services/__tests__/command-service.test.ts`

- [x] **Step 1: Write failing tests**

Append to `packages/server/src/services/__tests__/command-service.test.ts`:

```ts
describe('command-service — permission rules', () => {
  it('listPermissionRules: delegates to db', async () => {
    // The service currently takes `db` directly; imports below match existing test setup.
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
      reminderService: { list: vi.fn().mockReturnValue([]) } as any,
      permissionService: { hasPending: vi.fn() } as any,
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
      reminderService: { list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn() } as any,
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
      reminderService: { list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn() } as any,
      memoryService: null,
    });
    expect(svc.revokePermissionRule('ghost')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run --root packages/server packages/server/src/services/__tests__/command-service.test.ts
```

Expected: FAIL — `listPermissionRules is not a function`.

- [x] **Step 3: Implement**

Edit `packages/server/src/services/command-service.ts`. Extend the `CommandService` interface and the returned object:

```ts
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
```

Inside `createCommandService(deps)` returned object, add:

```ts
listPermissionRules() {
  const rows = deps.db
    .prepare('SELECT tool_name, allowed FROM permission_rules ORDER BY tool_name')
    .all() as Array<{ tool_name: string; allowed: number }>;
  return rows.map((r) => ({ toolName: r.tool_name, allowed: r.allowed === 1 }));
},
revokePermissionRule(toolName: string) {
  const result = deps.db
    .prepare('DELETE FROM permission_rules WHERE tool_name = ?')
    .run(toolName);
  return result.changes > 0
    ? ({ ok: true } as const)
    : ({ ok: false, reason: 'not_found' } as const);
},
```

- [x] **Step 4: Run tests**

```bash
npx vitest run --root packages/server packages/server/src/services
```

Expected: all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/services/command-service.ts packages/server/src/services/__tests__/command-service.test.ts
git commit -m "feat(services): command-service listPermissionRules / revokePermissionRule"
```

---

## Task 3: `tool-embeds.ts` — running state

**Files:**
- Create: `packages/server/src/channels/discord/tool-embeds.ts`
- Create: `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts`

This task introduces the module with just the `running` state. Progress/done/error added in Task 4.

- [x] **Step 1: Write failing test**

Create `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildToolCallEmbed, SILENT_TOOLS } from '../tool-embeds.js';
import type { ToolCall } from '@r2/shared';

function mkTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'call-1',
    name: 'file_write',
    input: { path: '/tmp/x.txt' },
    status: 'running',
    ...overrides,
  };
}

describe('SILENT_TOOLS', () => {
  it('contains memory_search and memory_save', () => {
    expect(SILENT_TOOLS).toContain('memory_search');
    expect(SILENT_TOOLS).toContain('memory_save');
  });
});

describe('buildToolCallEmbed — running', () => {
  it('returns null for silent tools', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool({ name: 'memory_search' }),
    });
    expect(result).toBeNull();
  });

  it('running embed has 🔧 icon and name', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool(),
    });
    expect(result).not.toBeNull();
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 file_write');
    expect(e.description).toBe('running…');
    // Discord color is an integer; running is gray
    expect(typeof e.color).toBe('number');
  });
});
```

- [x] **Step 2: Run test** — expect FAIL (module does not exist).

```bash
npx vitest run --root packages/server packages/server/src/channels/discord/__tests__/tool-embeds.test.ts
```

- [x] **Step 3: Implement minimal module**

Create `packages/server/src/channels/discord/tool-embeds.ts`:

```ts
import { EmbedBuilder } from 'discord.js';
import type { ToolCall } from '@r2/shared';

export type ToolCallState = 'running' | 'progress' | 'done' | 'error';

export const SILENT_TOOLS: readonly string[] = ['memory_search', 'memory_save'];

const COLORS = {
  gray: 0x9aa0a6,
  green: 0x22c55e,
  red: 0xef4444,
};

const DESCRIPTION_MAX = 3800;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export interface BuildToolCallEmbedOpts {
  state: ToolCallState;
  toolCall: ToolCall;
  progress?: string;
}

export function buildToolCallEmbed(opts: BuildToolCallEmbedOpts): EmbedBuilder | null {
  if (SILENT_TOOLS.includes(opts.toolCall.name)) return null;

  const embed = new EmbedBuilder();

  if (opts.state === 'running') {
    embed
      .setTitle(`🔧 ${opts.toolCall.name}`)
      .setDescription('running…')
      .setColor(COLORS.gray);
    return embed;
  }

  // Other states added in a later task.
  return embed;
}
```

- [x] **Step 4: Run test** — expect 3 passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/tool-embeds.ts packages/server/src/channels/discord/__tests__/tool-embeds.test.ts
git commit -m "feat(discord): tool-embeds module with running state"
```

---

## Task 4: `tool-embeds.ts` — progress/done/error + `code_task` special

**Files:**
- Modify: `packages/server/src/channels/discord/tool-embeds.ts`
- Modify: `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts`

- [x] **Step 1: Write failing tests**

Append to `tool-embeds.test.ts`:

```ts
describe('buildToolCallEmbed — progress', () => {
  it('progress state: title 🔧, description is progress text', () => {
    const result = buildToolCallEmbed({
      state: 'progress',
      toolCall: mkTool(),
      progress: 'writing bytes 512/1024',
    });
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 file_write');
    expect(e.description).toBe('writing bytes 512/1024');
  });

  it('progress: truncates description at 3800 chars', () => {
    const long = 'x'.repeat(5000);
    const result = buildToolCallEmbed({
      state: 'progress',
      toolCall: mkTool(),
      progress: long,
    });
    expect(result!.toJSON().description!.length).toBeLessThanOrEqual(3800);
  });
});

describe('buildToolCallEmbed — done', () => {
  it('done state: green, ✅ icon, result display content', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({
        status: 'done',
        result: { success: true, display: { type: 'text', content: 'wrote 100 bytes' } },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('✅ file_write');
    expect(e.description).toBe('wrote 100 bytes');
    expect(e.color).toBe(0x22c55e);
  });

  it('done with no display: description is fallback "done"', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({ status: 'done', result: { success: true } }),
    });
    expect(result!.toJSON().description).toBe('done');
  });
});

describe('buildToolCallEmbed — error', () => {
  it('error state: red, ❌, error text in description', () => {
    const result = buildToolCallEmbed({
      state: 'error',
      toolCall: mkTool({
        status: 'error',
        result: { success: false, error: 'permission denied' },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('❌ file_write');
    expect(e.description).toBe('permission denied');
    expect(e.color).toBe(0xef4444);
  });
});

describe('buildToolCallEmbed — code_task special', () => {
  it('running code_task: description is Task line', () => {
    const result = buildToolCallEmbed({
      state: 'running',
      toolCall: mkTool({
        name: 'code_task',
        input: { task: 'refactor auth' },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('🔧 code_task');
    expect(e.description).toContain('refactor auth');
  });

  it('done code_task: fields for Task, Commit, Files', () => {
    const result = buildToolCallEmbed({
      state: 'done',
      toolCall: mkTool({
        name: 'code_task',
        input: { task: 'refactor auth' },
        result: {
          success: true,
          data: {
            commit: 'abc1234567',
            mode: 'ralphex',
            files: [
              { path: 'src/a.ts', added: 5, removed: 1 },
              { path: 'src/b.ts', added: 2, removed: 0 },
            ],
            durationMs: 192000,
          },
        },
      }),
    });
    const e = result!.toJSON();
    expect(e.title).toBe('✅ code_task');
    const fieldNames = (e.fields ?? []).map((f: any) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(['Task', 'Commit', 'Files']));
    const filesField = (e.fields ?? []).find((f: any) => f.name === 'Files');
    expect(filesField?.value).toContain('src/a.ts');
    expect(filesField?.value).toContain('+5');
    expect(filesField?.value).toContain('-1');
  });
});
```

- [x] **Step 2: Run tests** — expect FAIL for progress/done/error/code_task specific.

- [x] **Step 3: Implement**

Replace the body of `buildToolCallEmbed` in `tool-embeds.ts` with:

```ts
export function buildToolCallEmbed(opts: BuildToolCallEmbedOpts): EmbedBuilder | null {
  if (SILENT_TOOLS.includes(opts.toolCall.name)) return null;

  const embed = new EmbedBuilder();
  const isCodeTask = opts.toolCall.name === 'code_task';
  const taskText =
    typeof opts.toolCall.input.task === 'string' ? opts.toolCall.input.task : '';

  // Title
  const iconByState: Record<ToolCallState, string> = {
    running: '🔧',
    progress: '🔧',
    done: '✅',
    error: '❌',
  };
  embed.setTitle(`${iconByState[opts.state]} ${opts.toolCall.name}`);

  // Color
  const colorByState: Record<ToolCallState, number> = {
    running: COLORS.gray,
    progress: COLORS.gray,
    done: COLORS.green,
    error: COLORS.red,
  };
  embed.setColor(colorByState[opts.state]);

  // State-specific body
  if (opts.state === 'running') {
    embed.setDescription(isCodeTask && taskText ? `Task: "${taskText}"` : 'running…');
    return embed;
  }

  if (opts.state === 'progress') {
    embed.setDescription(truncate(opts.progress ?? 'working…', DESCRIPTION_MAX));
    return embed;
  }

  if (opts.state === 'error') {
    const msg =
      opts.toolCall.result?.error ?? 'Unknown error';
    embed.setDescription(truncate(msg, DESCRIPTION_MAX));
    return embed;
  }

  // done
  if (isCodeTask) {
    const data = (opts.toolCall.result?.data ?? {}) as {
      commit?: string;
      mode?: string;
      files?: Array<{ path: string; added: number; removed: number }>;
      durationMs?: number;
    };
    if (taskText) {
      embed.addFields({ name: 'Task', value: truncate(`"${taskText}"`, 1024) });
    }
    if (data.commit) {
      const short = data.commit.slice(0, 7);
      const mode = data.mode ?? 'once';
      embed.addFields({ name: 'Commit', value: `\`${short}\` (${mode})` });
    }
    if (data.files && data.files.length > 0) {
      const lines = data.files
        .slice(0, 15)
        .map((f) => `\`${f.path}\` +${f.added} -${f.removed}`);
      if (data.files.length > 15) lines.push(`…and ${data.files.length - 15} more`);
      embed.addFields({ name: 'Files', value: truncate(lines.join('\n'), 1024) });
    }
    if (data.durationMs) {
      const sec = Math.round(data.durationMs / 1000);
      const mins = Math.floor(sec / 60);
      const secs = sec % 60;
      embed.setFooter({ text: `duration: ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}` });
    }
    if ((embed.data.fields ?? []).length === 0) {
      embed.setDescription('done');
    }
    return embed;
  }

  const display = opts.toolCall.result?.display?.content;
  embed.setDescription(truncate(display ?? 'done', Math.min(DESCRIPTION_MAX, 500)));
  return embed;
}
```

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/tool-embeds.ts packages/server/src/channels/discord/__tests__/tool-embeds.test.ts
git commit -m "feat(discord): tool-embed progress/done/error states + code_task special"
```

---

## Task 5: `tool-embeds.ts` — `buildDiffAttachment`

**Files:**
- Modify: `packages/server/src/channels/discord/tool-embeds.ts`
- Modify: `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts`

- [x] **Step 1: Write failing tests**

Append:

```ts
import { buildDiffAttachment } from '../tool-embeds.js';

describe('buildDiffAttachment', () => {
  const smallDiff = '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n';

  it('returns attachment with commit-prefixed name when commit present', () => {
    const result = buildDiffAttachment({
      callId: 'x',
      fullDiff: smallDiff,
      commit: 'abcdef1234567890',
    });
    expect(result).not.toBeNull();
    expect(result!.name).toBe('code_task_abcdef1.diff');
    expect(result!.attachment).toBeInstanceOf(Buffer);
    expect((result!.attachment as Buffer).toString('utf-8')).toBe(smallDiff);
  });

  it('falls back to callId when no commit', () => {
    const result = buildDiffAttachment({ callId: 'call-77', fullDiff: smallDiff });
    expect(result!.name).toBe('code_task_call-77.diff');
  });

  it('returns null when fullDiff empty', () => {
    expect(buildDiffAttachment({ callId: 'x', fullDiff: '' })).toBeNull();
  });

  it('returns { oversize: true } when diff > 24 MB', () => {
    const huge = 'x'.repeat(25 * 1024 * 1024);
    const result = buildDiffAttachment({ callId: 'x', fullDiff: huge });
    expect(result).toEqual({ oversize: true });
  });
});
```

- [x] **Step 2: Run tests** — expect FAIL.

- [x] **Step 3: Implement**

Append to `tool-embeds.ts`:

```ts
const DISCORD_UPLOAD_LIMIT_BYTES = 24 * 1024 * 1024; // safely below 25 MB

export interface DiffAttachment {
  attachment: Buffer;
  name: string;
}

export interface DiffAttachmentOversize {
  oversize: true;
}

export function buildDiffAttachment(opts: {
  callId: string;
  fullDiff: string;
  commit?: string;
}): DiffAttachment | DiffAttachmentOversize | null {
  if (!opts.fullDiff) return null;
  const buf = Buffer.from(opts.fullDiff, 'utf-8');
  if (buf.byteLength > DISCORD_UPLOAD_LIMIT_BYTES) {
    return { oversize: true };
  }
  const nameKey = opts.commit ? opts.commit.slice(0, 7) : opts.callId;
  return {
    attachment: buf,
    name: `code_task_${nameKey}.diff`,
  };
}
```

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/tool-embeds.ts packages/server/src/channels/discord/__tests__/tool-embeds.test.ts
git commit -m "feat(discord): buildDiffAttachment factory"
```

---

## Task 6: `embeds.ts` — `buildPermissionsListReply`

**Files:**
- Modify: `packages/server/src/channels/discord/embeds.ts`
- Modify: `packages/server/src/channels/discord/__tests__/embeds.test.ts`

- [x] **Step 1: Write failing tests**

Append to `embeds.test.ts`:

```ts
import { buildPermissionsListReply } from '../embeds.js';

describe('buildPermissionsListReply', () => {
  it('empty list: content is "No saved permission rules." and no components', () => {
    const reply = buildPermissionsListReply([]);
    expect(reply.content).toBe('No saved permission rules.');
    expect(reply.components).toEqual([]);
    expect(reply.embeds).toEqual([]);
  });

  it('rules list: embed + one button row per rule', () => {
    const reply = buildPermissionsListReply([
      { toolName: 'files_write', allowed: true },
      { toolName: 'code_deploy', allowed: false },
    ]);
    expect(reply.content).toBe('');
    expect(reply.embeds).toHaveLength(1);
    const embedJson = reply.embeds![0]!.toJSON();
    expect(embedJson.title).toBe('📋 Saved permission rules');
    expect(embedJson.description).toContain('files_write');
    expect(embedJson.description).toContain('code_deploy');
    // denied markers
    expect(embedJson.description).toContain('❌');
    expect(embedJson.description).toContain('✅');
    expect(reply.components).toHaveLength(2);
    const customIds = reply.components!.flatMap((row: any) =>
      (row.toJSON().components as any[]).map((c) => c.custom_id),
    );
    expect(customIds).toEqual([
      'perm_rule:revoke:files_write',
      'perm_rule:revoke:code_deploy',
    ]);
  });

  it('more than 5 rules: only 5 button rows, embed footer notes truncation', () => {
    const rules = Array.from({ length: 8 }, (_, i) => ({
      toolName: `tool_${i}`,
      allowed: true,
    }));
    const reply = buildPermissionsListReply(rules);
    expect(reply.components).toHaveLength(5);
    const embedJson = reply.embeds![0]!.toJSON();
    expect(embedJson.footer?.text).toContain('Showing 5 of 8');
  });
});
```

- [x] **Step 2: Run tests** — expect FAIL.

- [x] **Step 3: Implement**

Append to `embeds.ts`:

```ts
export interface PermissionsListReply {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

const MAX_REVOKE_BUTTONS = 5;

export function buildPermissionsListReply(
  rules: Array<{ toolName: string; allowed: boolean }>,
): PermissionsListReply {
  if (rules.length === 0) {
    return { content: 'No saved permission rules.', embeds: [], components: [] };
  }

  const lines = rules.map((r) => `${r.allowed ? '✅' : '❌'} \`${r.toolName}\``);
  const embed = new EmbedBuilder()
    .setTitle('📋 Saved permission rules')
    .setDescription(lines.join('\n'));

  const visible = rules.slice(0, MAX_REVOKE_BUTTONS);
  if (rules.length > MAX_REVOKE_BUTTONS) {
    embed.setFooter({ text: `Showing ${MAX_REVOKE_BUTTONS} of ${rules.length}. Revoke some and re-open /permissions.` });
  }

  const rows = visible.map((r) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm_rule:revoke:${r.toolName}`)
        .setLabel(`Revoke ${r.toolName}`)
        .setStyle(ButtonStyle.Danger),
    ),
  );

  return { content: '', embeds: [embed], components: rows };
}
```

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/embeds.ts packages/server/src/channels/discord/__tests__/embeds.test.ts
git commit -m "feat(discord): buildPermissionsListReply factory"
```

---

## Task 7: Register `/permissions` slash command

**Files:**
- Modify: `packages/server/src/channels/discord/slash-commands.ts`

- [x] **Step 1: Edit**

Inside `SLASH_COMMAND_DEFINITIONS` array, append:

```ts
new SlashCommandBuilder()
  .setName('permissions')
  .setDescription('View and revoke saved "Allow always" rules')
  .setDMPermission(true),
```

(Place before the final `.map((b) => b.toJSON())`.)

- [x] **Step 2: Run tests**

```bash
npx vitest run --root packages/server
```

Expected: all green (no slash-command test directly asserts list; Task 8 validates via interaction router).

- [x] **Step 3: Commit**

```bash
git add packages/server/src/channels/discord/slash-commands.ts
git commit -m "feat(discord): register /permissions slash command"
```

---

## Task 8: `/permissions` slash handler + revoke button handler

**Files:**
- Modify: `packages/server/src/channels/discord/interactions.ts`
- Modify: `packages/server/src/channels/discord/__tests__/interactions.test.ts`

- [x] **Step 1: Write failing tests**

Append to `interactions.test.ts`:

```ts
describe('routeInteraction — /permissions', () => {
  it('empty rules: ephemeral "No saved permission rules."', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'permissions' });
    await routeInteraction(ixn, deps);
    expect(ixn.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        flags: expect.anything(),
        content: 'No saved permission rules.',
      }),
    );
  });

  it('non-empty rules: ephemeral embed + revoke buttons', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([
          { toolName: 'files_write', allowed: true },
        ]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    const ixn = makeSlashInteraction({ commandName: 'permissions' });
    await routeInteraction(ixn, deps);
    const call = (ixn.reply as any).mock.calls[0][0];
    expect(call.embeds).toBeDefined();
    expect(call.components?.length).toBeGreaterThan(0);
  });
});

describe('routeInteraction — perm_rule:revoke', () => {
  it('existing rule: calls service, updates message with refreshed list', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValueOnce([
          { toolName: 'a', allowed: true },
          { toolName: 'b', allowed: true },
        ]).mockReturnValueOnce([{ toolName: 'b', allowed: true }]),
        revokePermissionRule: vi.fn().mockReturnValue({ ok: true }),
      } as any,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm_rule:revoke:a',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(deps.commandService.revokePermissionRule).toHaveBeenCalledWith('a');
    expect(ixn.update).toHaveBeenCalled();
  });

  it('unknown rule: still refreshes list (no-op revoke)', async () => {
    const deps = makeDeps({
      commandService: {
        clearHistory: vi.fn(),
        status: vi.fn(),
        listReminders: vi.fn(),
        listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi
          .fn()
          .mockReturnValue({ ok: false, reason: 'not_found' }),
      } as any,
    });
    const ixn = makeButtonInteraction({
      customId: 'perm_rule:revoke:ghost',
      message: { embeds: [{}] },
    });
    await routeInteraction(ixn, deps);
    expect(ixn.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No saved permission rules left.', components: [] }),
    );
  });
});
```

- [x] **Step 2: Run tests** — expect FAIL (handler not yet implemented).

- [x] **Step 3: Implement**

Edit `packages/server/src/channels/discord/interactions.ts`.

(a) Add import at top:

```ts
import { buildPermissionsListReply } from './embeds.js';
```

(b) Inside `routeSlashCommand`, add a branch before the closing `}`:

```ts
if (name === 'permissions') {
  const rules = deps.commandService.listPermissionRules();
  const reply = buildPermissionsListReply(rules);
  await (ixn as any).reply({
    flags: MessageFlags.Ephemeral,
    content: reply.content,
    embeds: reply.embeds,
    components: reply.components,
  });
  return;
}
```

(c) Inside `routeButton`, add a branch (after the existing `plan` block, before the function's end):

```ts
if (domain === 'perm_rule' && action === 'revoke') {
  const toolName = rawId ?? '';
  deps.commandService.revokePermissionRule(toolName);
  const remaining = deps.commandService.listPermissionRules();
  if (remaining.length === 0) {
    await (ixn as any).update({
      content: 'No saved permission rules left.',
      embeds: [],
      components: [],
    });
    return;
  }
  const reply = buildPermissionsListReply(remaining);
  await (ixn as any).update({
    content: reply.content,
    embeds: reply.embeds,
    components: reply.components,
  });
  return;
}
```

(d) Update the `makeDeps` helper in `interactions.test.ts` if its `commandService` default object doesn't include the new methods. Add:

```ts
listPermissionRules: vi.fn().mockReturnValue([]),
revokePermissionRule: vi.fn().mockReturnValue({ ok: true }),
```

to the default `commandService` in `makeDeps`.

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/interactions.ts packages/server/src/channels/discord/__tests__/interactions.test.ts
git commit -m "feat(discord): /permissions slash + perm_rule:revoke handler"
```

---

## Task 9: Bot — tool-call embed on `tool_call_start`

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [x] **Step 1: Write failing test**

Append to `bot.test.ts`:

```ts
describe('tool_call_start handling', () => {
  it('sends a tool-call embed and tracks messageId', async () => {
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: { path: '/tmp/x' }, status: 'running' },
      });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;
    (dmChannel.send as any).mockResolvedValue({ id: 'sent-msg-1', edit: vi.fn().mockResolvedValue(undefined) });

    const { stop } = await startDiscordBot({
      token: 'test',
      whitelist: new Set(['123']),
      runChatRequest,
      db: makeFakeDb() as any,
      historyLimit: 10,
      saveMessage: vi.fn(),
      memoryService: null,
      _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]),
        revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const embedCalls = (dmChannel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && 'embeds' in c[0],
    );
    expect(embedCalls.length).toBeGreaterThan(0);
    const firstEmbed = embedCalls[0][0].embeds[0];
    expect(firstEmbed.toJSON().title).toBe('🔧 file_write');
    await stop();
  });

  it('silent tool (memory_search): no embed sent', async () => {
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'memory_search', input: {}, status: 'running' },
      });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const embedCalls = (dmChannel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && 'embeds' in c[0],
    );
    expect(embedCalls.length).toBe(0);
    await stop();
  });
});
```

- [x] **Step 2: Run test** — expect FAIL.

- [x] **Step 3: Implement**

Edit `packages/server/src/channels/discord/bot.ts`:

(a) Add import at top:

```ts
import { buildToolCallEmbed, buildDiffAttachment, SILENT_TOOLS } from './tool-embeds.js';
```

(b) Inside `handleMessage`, before the retry loop, add state:

```ts
type ToolCallEntry = {
  messageId: string;
  final: boolean;
  lastEditAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  latestProgress: string | null;
};
const toolCallMessages = new Map<string, ToolCallEntry>();
```

(c) Add branch inside the `sendChain.then(async () => { ... })` onEvent body, before the `if (event.type === 'done' ...)` line:

```ts
if (event.type === 'tool_call_start') {
  if (SILENT_TOOLS.includes(event.toolCall.name)) return;
  const embed = buildToolCallEmbed({ state: 'running', toolCall: event.toolCall });
  if (!embed) return;
  await flush();
  const sent = await dmChannel.send({ embeds: [embed] });
  toolCallMessages.set(event.toolCall.id, {
    messageId: sent.id,
    final: false,
    lastEditAt: Date.now(),
    pendingTimer: null,
    latestProgress: null,
  });
  return;
}
```

- [x] **Step 4: Run tests** — all passing.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): send tool-call embed on tool_call_start"
```

---

## Task 10: Bot — debounced `tool_progress` edits

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [ ] **Step 1: Write failing test**

Append to `bot.test.ts`:

```ts
describe('tool_progress handling (debounced)', () => {
  it('fires immediate edit on first progress, then respects 800ms cooldown', async () => {
    vi.useFakeTimers();
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: {}, status: 'running' },
      });
      onEvent({ type: 'tool_progress', id: 'c-1', message: 'step 1' });
      onEvent({ type: 'tool_progress', id: 'c-1', message: 'step 2' });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;
    (dmChannel.send as any).mockResolvedValue({
      id: 'sent-1',
      edit: editMock,
    });
    (dmChannel.messages as any) = {
      fetch: vi.fn().mockResolvedValue({ edit: editMock }),
    };

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await vi.runAllTimersAsync();
    await new Promise((r) => setImmediate(r));

    // At least the immediate + the flush-on-done edit should happen.
    // The second progress within 800ms is debounced and flushed as part of terminal done state.
    expect(editMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    await stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Add a helper inside `handleMessage` (near other helpers):

```ts
const PROGRESS_DEBOUNCE_MS = 800;

const applyProgressEdit = async (callId: string, progress: string) => {
  const entry = toolCallMessages.get(callId);
  if (!entry || entry.final) return;
  try {
    const msgRef = await dmChannel.messages.fetch(entry.messageId);
    const fakeTool = {
      id: callId,
      name: 'unknown',
      input: {},
      status: 'running' as const,
    };
    // We kept only id in the map; re-fetch toolCall name from message embed title.
    // Simpler: maintain toolCall snapshot in the map.
    const embed = buildToolCallEmbed({
      state: 'progress',
      toolCall: { ...fakeTool, name: entry.toolName ?? 'unknown' },
      progress,
    });
    if (embed) await msgRef.edit({ embeds: [embed] });
    entry.lastEditAt = Date.now();
  } catch {
    // Message deleted or Discord hiccup — ignore.
  }
};

const onProgress = (callId: string, progress: string) => {
  const entry = toolCallMessages.get(callId);
  if (!entry || entry.final) return;
  const elapsed = Date.now() - entry.lastEditAt;
  if (elapsed >= PROGRESS_DEBOUNCE_MS) {
    // Immediate
    void applyProgressEdit(callId, progress);
    return;
  }
  // Cooldown active — schedule trailing edit
  entry.latestProgress = progress;
  if (!entry.pendingTimer) {
    const delay = PROGRESS_DEBOUNCE_MS - elapsed;
    entry.pendingTimer = setTimeout(() => {
      entry.pendingTimer = null;
      const latest = entry.latestProgress ?? progress;
      entry.latestProgress = null;
      void applyProgressEdit(callId, latest);
    }, delay);
  }
};
```

(Note: the helper references `entry.toolName` — extend the `ToolCallEntry` type with `toolName: string` and set it when creating the entry in Task 9. Update Task 9's `toolCallMessages.set` call to include `toolName: event.toolCall.name`.)

In the `onEvent` body, add branch for `tool_progress`:

```ts
if (event.type === 'tool_progress') {
  onProgress(event.id, event.message);
  return;
}
```

Extend the `ToolCallEntry` type declared in Task 9:

```ts
type ToolCallEntry = {
  messageId: string;
  toolName: string;
  final: boolean;
  lastEditAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  latestProgress: string | null;
};
```

And update Task 9's `toolCallMessages.set` to include `toolName: event.toolCall.name`:

```ts
toolCallMessages.set(event.toolCall.id, {
  messageId: sent.id,
  toolName: event.toolCall.name,
  final: false,
  lastEditAt: Date.now(),
  pendingTimer: null,
  latestProgress: null,
});
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): debounced tool_progress edits (800ms)"
```

---

## Task 11: Bot — `tool_call_result` → terminal edit + diff attachment

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `bot.test.ts`:

```ts
describe('tool_call_result handling', () => {
  it('done result: edits embed to done state', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'file_write', input: {}, status: 'running' },
      });
      onEvent({
        type: 'tool_call_result',
        id: 'c-1',
        result: { success: true, display: { type: 'text', content: 'wrote 42 bytes' } },
      });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;
    (dmChannel.send as any).mockResolvedValue({ id: 'sent-1', edit: editMock });
    (dmChannel.messages as any) = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(editMock).toHaveBeenCalled();
    // verify last edit's embed has ✅ title
    const lastCall = editMock.mock.calls[editMock.mock.calls.length - 1];
    const lastEmbed = lastCall[0].embeds[0].toJSON();
    expect(lastEmbed.title).toBe('✅ file_write');
    await stop();
  });

  it('code_task with fullDiff: sends attachment follow-up', async () => {
    const editMock = vi.fn().mockResolvedValue(undefined);
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'c-1', name: 'code_task', input: { task: 't' }, status: 'running' },
      });
      onEvent({
        type: 'tool_call_result',
        id: 'c-1',
        result: {
          success: true,
          data: {
            commit: 'abcdef1234',
            files: [{ path: 'a.ts', added: 1, removed: 0 }],
            fullDiff: '--- a\n+++ b\n@@ @@\n-old\n+new\n',
          },
        },
      });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;
    (dmChannel.send as any).mockResolvedValue({ id: 'sent-1', edit: editMock });
    (dmChannel.messages as any) = { fetch: vi.fn().mockResolvedValue({ edit: editMock }) };

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const fileCalls = (dmChannel.send as any).mock.calls.filter(
      (c: any[]) => typeof c[0] === 'object' && 'files' in c[0],
    );
    expect(fileCalls.length).toBe(1);
    const attachment = fileCalls[0][0].files[0];
    expect(attachment.name).toBe('code_task_abcdef1.diff');
    await stop();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Inside `handleMessage` `onEvent`, add branch for `tool_call_result`:

```ts
if (event.type === 'tool_call_result') {
  const entry = toolCallMessages.get(event.id);
  if (!entry || entry.final) return;
  // Cancel any pending progress edit
  if (entry.pendingTimer) {
    clearTimeout(entry.pendingTimer);
    entry.pendingTimer = null;
    entry.latestProgress = null;
  }
  const isSuccess = event.result.success;
  const state = isSuccess ? 'done' : 'error';
  const toolCallSnapshot = {
    id: event.id,
    name: entry.toolName,
    input: {},
    status: state === 'done' ? ('done' as const) : ('error' as const),
    result: event.result,
  };
  const embed = buildToolCallEmbed({ state, toolCall: toolCallSnapshot });
  try {
    const msgRef = await dmChannel.messages.fetch(entry.messageId);
    if (embed) await msgRef.edit({ embeds: [embed] });
  } catch {
    // Ignore missing / deleted message
  }
  entry.final = true;

  // Follow-up diff attachment for code_task
  if (isSuccess && entry.toolName === 'code_task') {
    const data = (event.result.data ?? {}) as {
      fullDiff?: string;
      commit?: string;
    };
    if (typeof data.fullDiff === 'string' && data.fullDiff.length > 0) {
      const diff = buildDiffAttachment({
        callId: event.id,
        fullDiff: data.fullDiff,
        commit: data.commit,
      });
      if (diff && 'attachment' in diff) {
        try {
          await dmChannel.send({ files: [{ attachment: diff.attachment, name: diff.name }] });
        } catch (err) {
          console.error('[discord] diff attachment failed:',
            err instanceof Error ? err.message : err);
        }
      } else if (diff && 'oversize' in diff) {
        const commitSha = data.commit ?? event.id;
        try {
          await dmChannel.send(`⚠️ diff too large to attach, saved in commit \`${commitSha.slice(0, 7)}\``);
        } catch {}
      }
    }
  }
  return;
}
```

Also, where `buildToolCallEmbed` is called, keep `toolCall` snapshot. Snapshot above uses an empty `input: {}` — `buildToolCallEmbed` for `code_task` pulls `input.task` — so adjust the snapshot to include `input` from original `tool_call_start` if you want Task field to render properly. Extend `ToolCallEntry` to carry the input:

```ts
type ToolCallEntry = {
  messageId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  final: boolean;
  lastEditAt: number;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  latestProgress: string | null;
};
```

And set `toolInput: event.toolCall.input` when creating the entry (update Task 9). Then the snapshot becomes:

```ts
const toolCallSnapshot = {
  id: event.id,
  name: entry.toolName,
  input: entry.toolInput,
  status: state === 'done' ? 'done' : 'error',
  result: event.result,
} as const;
```

Update `applyProgressEdit` likewise to pass `entry.toolInput`.

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): tool_call_result terminal edit + diff attachment"
```

---

## Task 12: Bot — escalation prefix (`🔵 claude`)

**Files:**
- Modify: `packages/server/src/channels/discord/bot.ts`
- Modify: `packages/server/src/channels/discord/__tests__/bot.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `bot.test.ts`:

```ts
describe('escalation prefix', () => {
  it('ollama → claude: prefix on first flush', async () => {
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({ type: 'assistant_source', source: 'ollama' });
      onEvent({ type: 'text_delta', content: 'hi' });
      onEvent({ type: 'assistant_source', source: 'claude' });
      onEvent({ type: 'text_delta', content: ' world' });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const textCalls = (dmChannel.send as any).mock.calls
      .filter((c: any[]) => typeof c[0] === 'string');
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0]).toBe('🔵 claude\n\nhi world');
    await stop();
  });

  it('claude only (no prior ollama): no prefix', async () => {
    const runChatRequest = vi.fn(async ({ onEvent }: any) => {
      onEvent({ type: 'assistant_source', source: 'claude' });
      onEvent({ type: 'text_delta', content: 'hello' });
      onEvent({ type: 'done' });
    });
    const client = makeFakeClient();
    const msg = makeMessage({ author: { bot: false, id: '123' } });
    const dmChannel = msg.channel;

    const { stop } = await startDiscordBot({
      token: 'test', whitelist: new Set(['123']), runChatRequest,
      db: makeFakeDb() as any, historyLimit: 10, saveMessage: vi.fn(),
      memoryService: null, _client: client,
      reminderService: { dismiss: vi.fn(), snooze: vi.fn(), list: vi.fn() } as any,
      permissionService: { hasPending: vi.fn(), resolveConfirm: vi.fn() } as any,
      planReviewService: { hasPending: vi.fn(), resolveReview: vi.fn() } as any,
      commandService: {
        clearHistory: vi.fn(), status: vi.fn(), listReminders: vi.fn(), listMemory: vi.fn(),
        listPermissionRules: vi.fn().mockReturnValue([]), revokePermissionRule: vi.fn(),
      } as any,
    });
    (client as any).emit('messageCreate', msg.msg);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const textCalls = (dmChannel.send as any).mock.calls
      .filter((c: any[]) => typeof c[0] === 'string');
    expect(textCalls.length).toBe(1);
    expect(textCalls[0][0]).toBe('hello');
    await stop();
  });
});
```

- [ ] **Step 2: Run test** — expect FAIL.

- [ ] **Step 3: Implement**

Inside `handleMessage`, add state near `toolCallMessages`:

```ts
let sawOllama = false;
let escalated = false;
```

Update the existing `flush` helper to prepend the prefix:

```ts
const flush = async () => {
  if (!buffer) return;
  let text = buffer;
  if (escalated) {
    text = `🔵 claude\n\n${text}`;
    escalated = false;
  }
  await sendReply(dmChannel, text);
  sendSucceeded = true;
  buffer = '';
};
```

Inside `onEvent`, before the `tool_call_start` branch, add:

```ts
if (event.type === 'assistant_source') {
  if (event.source === 'ollama') {
    sawOllama = true;
  } else if (event.source === 'claude' && sawOllama) {
    escalated = true;
  }
  return;
}
```

Also ensure that on retry (the existing retry loop resets state) `sawOllama` and `escalated` are reset — add them to the retry reset block:

```ts
// inside for (let attempt = 0; ; attempt++) {
buffer = '';
assistantText = '';
errorSent = false;
sendChain = Promise.resolve();
sendError = null;
sawOllama = false;        // NEW
escalated = false;        // NEW
```

- [ ] **Step 4: Run tests** — all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/discord/bot.ts packages/server/src/channels/discord/__tests__/bot.test.ts
git commit -m "feat(discord): 🔵 claude prefix on ollama→claude escalation"
```

---

## Task 13: Full integration — run all server tests, fix any fallout

**Files:** all

- [ ] **Step 1: Run full suite**

```bash
npx vitest run --root packages/server
```

Expected: all passing. Any mock that previously omitted `listPermissionRules` / `revokePermissionRule` on `commandService` stubs in other tests must be updated.

- [ ] **Step 2: Typecheck**

```bash
npm run build -w @r2/server
```

Expected: no TypeScript errors.

- [ ] **Step 3: Lint / shared typecheck**

```bash
npx tsc -p packages/shared --noEmit && npx tsc -p packages/server --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit any stub fixes (if any made)**

```bash
git add -A
git commit -m "chore(test): fix stub coverage for new command-service methods"
```

(If nothing was changed, skip.)

---

## Task 14: Manual E2E

**Goal:** Verify the four features work against real Discord.

- [ ] **Step 1: Start dev server**

```bash
cd /Users/dim/code/R2-D2 && npm run dev
```

Confirm logs show `[discord] bot started` and `[discord] slash commands registered`.

- [ ] **Step 2: Tool embed (generic)**

In Discord DM ask:
```
write "hello" to /tmp/r2_phase2_test.txt
```

Verify:
- A blue-grey embed appears with `🔧 file_write` + description.
- After write completes, the same embed edits to green with `✅ file_write` and result text.
- No duplicate text message is sent.

- [ ] **Step 3: Silent tool skip**

Ask a question that triggers `memory_search` (e.g. "what do you know about the mac mini plan?"). Verify no `🔧 memory_search` embed appears.

- [ ] **Step 4: code_task + diff attachment**

Ask R2 to do a trivial code change (e.g. "add a comment to packages/server/src/db.ts"). Verify:
- `🔧 code_task` embed appears, then edits to `✅ code_task` with Task/Commit/Files fields.
- A follow-up message arrives with a `code_task_<sha>.diff` attachment.
- Clicking the attachment shows diff preview with +/- colouring.

- [ ] **Step 5: Escalation prefix**

Ask a complex reasoning question that forces Claude (e.g. "write a regex that matches balanced parentheses and explain the limitation"). Verify:
- Reply starts with `🔵 claude` on its own line.
- Normal local-LLM replies have no such prefix.

- [ ] **Step 6: `/permissions`**

```
/permissions
```

Verify empty state → "No saved permission rules." Then trigger a prompt that requires confirmation (e.g. file_write) and click **Allow always**. Run `/permissions` again. Verify the rule is listed with a `Revoke {tool}` button. Click revoke → message updates without that rule.

- [ ] **Step 7: Non-owner auth check**

(Skip if no secondary account available.) Confirm a non-whitelisted user is rejected.

- [ ] **Step 8: Document findings**

Append a "Manual E2E results" block to `docs/superpowers/specs/2026-04-17-discord-phase2-design.md`. Commit.

```bash
git add docs/superpowers/specs/2026-04-17-discord-phase2-design.md
git commit -m "docs(spec): mark discord phase 2 E2E verified"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-04-17-discord-phase2-design.md`:

- §1 tool-call embed lifecycle → Tasks 3, 4, 9, 10, 11
- §1 SILENT_TOOLS → Task 3 (constant), Task 9 (skip logic)
- §1 debounce 800 ms → Task 10
- §2 diff attachment → Tasks 5, 11
- §2 oversize fallback → Task 5 (factory), Task 11 (sender)
- §3 escalation prefix → Task 12
- §4 `/permissions` slash + revoke buttons → Tasks 6, 7, 8
- §5 db and command-service → Tasks 1, 2
- §6 file list → matches tasks
- §7 testing coverage → each task has its own tests; Task 13 runs the full suite
- §8 risks (message deletion, timeouts) → handled by try/catch around `messages.fetch().edit()` in Task 10, 11; no new code needed

No TODOs / placeholders. Types:
- `ToolCallEntry` defined in Task 9, extended in Task 10 (`toolName`) and Task 11 (`toolInput`). Each extension step is explicit — implementer reads Task 10 and Task 11 to update the Task 9 declaration.
- `buildPermissionsListReply` (Task 6) referenced by Task 8.
- `buildToolCallEmbed`, `buildDiffAttachment`, `SILENT_TOOLS` (Tasks 3, 4, 5) referenced by Tasks 9, 10, 11.
- `listPermissionRules`, `revokePermissionRule` on `CommandService` (Task 2) referenced by Task 8.
