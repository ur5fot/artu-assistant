# Discord Phase 2 — tool embeds, diff attachments, source indicator, permissions

## Problem

Phase 1 made Discord the primary entry point with reminder/permission/plan-review buttons and slash commands. Four gaps from web UI remain:

1. **Tool calls are invisible.** During tool execution the bot shows no status — user sees silence between text chunks. Web has `ToolCallCard` with running/progress/done/error states.
2. **Diffs are lost.** `code_task` produces a `fullDiff` that web renders via `DiffView`. In Discord the field is dropped — if R2 modified code, the user can only see the commit sha, not what changed.
3. **No way to manage "Allow always" rules.** Once a user clicks "Allow always" for a tool, the rule persists in `permission_rules` table. There is no way from Discord to list or revoke these rules. Web doesn't expose this either, but the web is frozen.
4. **No escalation signal.** The router decides whether to answer locally (Ollama) or escalate to Claude. The user has no way to know which model answered — so you can't tell when local LLM is failing and work is quietly going to the paid API.

## Non-goals

- Porting `MemoryRecalledCard`, `PiiBadge` — low-signal, defer.
- Plan editing from Discord (modal API) — rare case, web fallback acceptable.
- Selective message deletion (`/clear` suffices).
- Marking provider on individual tool-call embeds — noise without benefit.
- Pagination for tool-call embeds or permission rules (>25 rules unlikely in personal use).
- Changes to web UI.

## Design

### 1. Tool call embed lifecycle

One embed per tool call, edited through three states. Tracked in a per-request `Map<callId, messageId>` in the bot's `handleMessage` closure.

**State: running** (on `tool_call_start`)
```
🔧 file_write
running…
```
Gray accent; no footer.

**State: progress** (on `tool_progress`)
```
🔧 file_write
writing /tmp/x.txt (1024 bytes)
```
Gray; description replaced with the latest progress line.

**State: done** (on `tool_call_result` success=true)
```
✅ file_write
/tmp/x.txt
```
Green. Description contains `result.display.content` (first 500 chars) if present; otherwise a short summary line.

**State: error** (on `tool_call_result` success=false)
```
❌ file_write
{error message from result.error}
```
Red.

**Constraints:**
- Description truncated to 3800 chars (safe margin on the 4096 embed limit).
- Max 4 fields: Task / Commit / Files / Error. Anything richer goes into description.
- After a terminal (`done` / `error`) edit, the entry is marked `final: true` in the map. Any further events for that `callId` are no-ops.
- Progress edits are **debounced to 800 ms** per `callId`: if a second `tool_progress` arrives within 800 ms of the last edit, it replaces the pending edit but does not fire immediately. A terminal event (`done` / `error`) flushes any pending edit and then does its own edit. This keeps the embed under Discord's ~5 edits/5s per-channel rate limit for rapid progress streams.
- `toolCallMessages` map lives in the per-`handleMessage` closure and is cleaned when the request ends.

**Silent tools:**

A `SILENT_TOOLS` constant lists tools that get no embed. Initial set: `['memory_search', 'memory_save']`. These fire frequently as background ops and would spam DMs.

**Special case: `code_task`**

When the tool name is `code_task` and `result.data` has the expected shape, the done-state embed shows:
```
✅ code_task (3m 12s)
Task: "<task description>"
Commit: abc1234 (ralphex)
📁 4 files changed
  src/foo.ts +15 -3
  src/bar.ts +8 -0
```
as fields (Task, Commit, Files), plus a description summary. The `fullDiff` is delivered as a separate follow-up message (§2), not inlined in the embed — it would blow the 6000-char total embed budget.

### 2. Diff attachment

On `tool_call_result` where `toolCall.name === 'code_task'`, `result.success === true`, and `result.data.fullDiff` is non-empty, send a follow-up message with a `.diff` attachment:

```ts
await dmChannel.send({
  files: [{
    attachment: Buffer.from(fullDiff, 'utf-8'),
    name: `code_task_${commitShort}.diff`,
  }],
});
```

- Filename: `code_task_{commit7chars}.diff` if commit present; fallback `code_task_{callId}.diff`.
- No content text — the embed already rendered the summary.
- Discord auto-highlights unified-diff syntax in its inline preview (green/red on +/-). Clicking expands without download.

**Size limit:**
- Free Discord upload is 25 MB. Typical diff is 10 KB–1 MB.
- If `Buffer.byteLength(fullDiff, 'utf-8') > 24 * 1024 * 1024` — skip the attachment, append to the embed footer: `⚠️ diff too large (${mb} MB), saved in commit {sha}`. The diff is still in git.

**`shortDiff` fallback:**
- If `data.shortDiff` exists but `fullDiff` does not (rare), render as a `diff` code block in the embed description; no attachment.

**Error handling:**
- `dmChannel.send` failure (rate limit, network) is logged but does not fail the overall request. The embed already delivered the result.

### 3. Escalation indicator (🔵 claude)

The router emits `assistant_source: 'ollama'` when the local path handles the turn, `assistant_source: 'claude'` when it escalates or goes straight to Claude. We want to distinguish "silent direct Claude" from "Ollama tried and gave up" — only the latter is the meaningful signal.

**State (per `handleMessage` call):**
```ts
let sawOllama = false;
let escalated = false;
```

**Detection:**
- On `assistant_source: 'ollama'` → `sawOllama = true`.
- On `assistant_source: 'claude'` AND `sawOllama` → `escalated = true`.

**Application:**
- At the first `flush()` after `escalated` is set, prepend `🔵 claude\n\n` to the buffer and reset `escalated = false`.

```ts
const flush = async () => {
  if (!buffer) return;
  let text = buffer;
  if (escalated) {
    text = `🔵 claude\n\n${text}`;
    escalated = false;
  }
  await sendReply(dmChannel, text);
  buffer = '';
  sendSucceeded = true;
};
```

**Rules:**
- `🟢 ollama` is never shown. Default assumption is that ollama answered.
- If `assistant_source: 'claude'` arrives without a prior ollama signal (e.g. `forceProvider: 'claude'`, or message history contains unsupported content), `sawOllama` stays false and no prefix is added. This is correct — it wasn't an escalation.
- The prefix is added at most once per user turn: the flag is cleared after use.

### 4. `/permissions` slash command

Lists saved `permission_rules` entries (rules created via "Allow always"), with a Revoke button per rule.

**Registration** (in `slash-commands.ts`):
```ts
new SlashCommandBuilder()
  .setName('permissions')
  .setDescription('View and revoke saved "Allow always" rules')
  .setDMPermission(true)
```

**Handler** (in `interactions.ts routeSlashCommand`):
1. `commandService.listPermissionRules()` → `Array<{ toolName, allowed }>`.
2. Empty → ephemeral reply: `No saved permission rules.`
3. Non-empty → ephemeral embed with one button row per rule:

```
📋 Saved permission rules

✅ files.write
✅ reminder.create
❌ code_deploy (denied)

[✗ Revoke files.write]
[✗ Revoke reminder.create]
[✗ Revoke code_deploy]
```

Button customId format: `perm_rule:revoke:{toolName}`.

**Layout:**
- One button per row (so each button's label fits the tool name comfortably).
- Max 5 rows = 5 buttons per message due to Discord row limits. If more than 5 rules exist, put them in one ephemeral message with 5 action rows of 1 button each → 5 revokable at a time, plus footer `Showing 5 of N. Revoke and re-open /permissions to continue.` In MVP we accept the 5-at-a-time interaction; pagination is not worth the complexity for a personal bot.

**Revoke handler** (in `interactions.ts routeButton`):
```ts
if (domain === 'perm_rule' && action === 'revoke') {
  const toolName = rawId;
  const result = commandService.revokePermissionRule(toolName);
  const remaining = commandService.listPermissionRules();
  const { embed, components } = buildPermissionsListReply(remaining);
  await ixn.update({ embeds: [embed], components });
}
```

If `remaining` is empty, the update message becomes `No saved permission rules left.` with no components.

**Authorization:** already enforced by the whitelist check at the top of `routeInteraction`.

No confirmation step — a single click is enough (unlike `/clear`, which wipes history). Re-creating a rule requires a tool prompt anyway.

### 5. Service and DB changes

**`db.ts` — new functions:**
```ts
export function listPermissionRules(): Array<{ toolName: string; allowed: boolean }> {
  const rows = getDb()
    .prepare('SELECT tool_name, allowed FROM permission_rules ORDER BY tool_name')
    .all() as Array<{ tool_name: string; allowed: number }>;
  return rows.map((r) => ({ toolName: r.tool_name, allowed: r.allowed === 1 }));
}

export function deletePermissionRule(toolName: string): boolean {
  const result = getDb()
    .prepare('DELETE FROM permission_rules WHERE tool_name = ?')
    .run(toolName);
  return result.changes > 0;
}
```

No schema migration — the `permission_rules` table already exists.

**`command-service.ts` — extend:**
```ts
interface CommandService {
  // existing: clearHistory, status, listReminders, listMemory
  listPermissionRules(): Array<{ toolName: string; allowed: boolean }>;
  revokePermissionRule(toolName: string): { ok: true } | { ok: false; reason: 'not_found' };
}
```

These slash-command operations naturally belong to `CommandService`, not `PermissionService`. `PermissionService` handles request-lifecycle state (pending confirms); rule CRUD is a command-layer concern.

### 6. Files

**New:**
- `packages/server/src/channels/discord/tool-embeds.ts` — `buildToolCallEmbed`, `buildDiffAttachment`, `SILENT_TOOLS`.
- `packages/server/src/channels/discord/__tests__/tool-embeds.test.ts`.

**Modified:**

| File | Change |
|---|---|
| `channels/discord/bot.ts` | `onEvent` handles `tool_call_start` / `tool_progress` / `tool_call_result` / `assistant_source`; `toolCallMessages`, `sawOllama`, `escalated` state; `flush` prepends `🔵 claude`; code_task attachment follow-up |
| `channels/discord/interactions.ts` | `/permissions` slash handler + `perm_rule:revoke:*` button handler; import `buildPermissionsListReply` |
| `channels/discord/slash-commands.ts` | register `/permissions` |
| `channels/discord/embeds.ts` | new `buildPermissionsListReply(rules)` factory |
| `services/command-service.ts` | add `listPermissionRules`, `revokePermissionRule` |
| `services/__tests__/command-service.test.ts` | tests for the two new operations |
| `db.ts` | add `listPermissionRules`, `deletePermissionRule` |
| `channels/discord/__tests__/bot.test.ts` | tool embed lifecycle + escalation prefix |
| `channels/discord/__tests__/interactions.test.ts` | `/permissions` slash + revoke button |
| `channels/discord/__tests__/embeds.test.ts` | `buildPermissionsListReply` |

### 7. Testing

**Unit:**
- `tool-embeds.test.ts` — pure factory: running/progress/done/error for generic tool, code_task special (Task/Commit/Files fields), `SILENT_TOOLS` returns null, description truncation at 3800 chars, attachment filename format, 24 MB oversize fallback.
- `embeds.test.ts` (`buildPermissionsListReply`) — empty list message, 1 rule, 5 rules, 8 rules (shows 5 with footer), denied rules show ❌.
- `command-service.test.ts` — `listPermissionRules` delegates to db, `revokePermissionRule` returns `{ ok: true }` on success and `{ ok: false, reason: 'not_found' }` when db returns false.

**Interaction router:**
- `/permissions` empty → ephemeral "No saved permission rules."
- `/permissions` with 3 rules → ephemeral embed + 3 revoke rows, correct customIds.
- `perm_rule:revoke:files.write` → service called, message updated with remaining rules.
- `perm_rule:revoke:unknown` → service returns not_found → message updated anyway with refreshed list (silently drops stale entry).

**Bot integration:**
- Emit `tool_call_start` → `tool_progress` → `tool_call_result (success)` for `file_write` → verify send + edit + edit sequence, final embed is green `done` state.
- Emit `tool_call_start` → `tool_call_result (error)` → verify edit to red.
- `memory_search` tool call → no embed sent (SILENT_TOOLS).
- `code_task` with `fullDiff` → after done edit, a follow-up `files: [...]` send is called with `.diff` attachment.
- `code_task` with `fullDiff` > 24 MB → no attachment, footer shows oversize notice.
- Escalation: `assistant_source: ollama` → `text_delta: 'A'` → `assistant_source: claude` → `text_delta: 'B'` → `done` → single DM sent with content `🔵 claude\n\nAB`.
- No escalation: `assistant_source: claude` first (no ollama) → `text_delta: 'X'` → `done` → DM `X` without prefix.

### 8. Risks / open points

- **Edit rate limits.** Mitigated by the 800 ms debounce (§1). Unit tests must cover: rapid progress stream still produces a correct final embed after `done` flushes the pending edit.
- **Message deletion during request.** User could delete the tool embed message manually between edits. `messages.fetch().edit()` will throw. Catch and ignore — nothing to do.
- **Long-running `code_task` and timeout.** The 300s request timeout still applies. If a `code_task` embeds is in `progress` state when the request aborts, the embed stays in progress forever. Acceptable — on retry the next request overwrites context.
- **Escalation after tool call.** If the router escalates only after running several tools (unlikely but possible in a compound turn), the prefix still fires on the first flush after `escalated` is set, which happens at or after the `assistant_source: claude` event. Correct.

## Summary of new constants / types

- `SILENT_TOOLS: readonly string[]` — in `tool-embeds.ts`.
- `ToolCallState = 'running' | 'progress' | 'done' | 'error'` — in `tool-embeds.ts`.
- Button customId: `perm_rule:revoke:{toolName}`.
- Slash command: `/permissions`.
