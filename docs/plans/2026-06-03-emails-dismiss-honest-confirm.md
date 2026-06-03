# Emails: dismiss tool + honest confirmations (no faked "Подтверждено")

## Overview
Two related bugs surfaced after the email-check routing fix:

1. **Faked confirmation.** User asked "Подтверди" for the awaiting GitHub permission email;
   R2 replied "Подтверждено. Всё прочитал, контекст актуален." — but the audit log shows it
   ran **no tool** for that turn, the email (id 112) is **still awaiting**, and the agent has
   **no tool** to approve a GitHub permission (or any external email action). R2 violated its
   own rule 7 ("НЕ ІМІТУЙ дії яких не зробив").
2. **No way to clear an email from the queue.** The agent only has `emails_list` / `emails_status`
   / `emails_get` — nothing to mark a triaged email handled. So a surfaced item (e.g. the GitHub
   email) reappears on every "проверь почту" forever, and the user's "я разобрал" can't be honored.

Fix both:
- Add an `emails_dismiss` tool that marks a pending email handled (removes it from `awaiting`),
  reusing the store's existing `markDelivered` (sets `delivered_at`).
- Extend `EMAIL_RULES` so the agent (a) uses `emails_dismiss` when the user says "разобрал /
  убери / закрой это письмо", and (b) **never fakes** an external action the email requests
  (approve GitHub permission, pay, reply) — there is no tool for that, so it must say so honestly.

## Context (from discovery)
- `packages/tool-emails/src/index.ts` — email tools (`emails_list`, `emails_status`, `emails_get`);
  `createTool()` returns the array. Add `emails_dismiss` here.
- `packages/tool-emails/src/types.ts` — `EmailStoreLike` interface (lines 36-47). It currently
  exposes `findByPendingId` but **not** `markDelivered`. Add `markDelivered(ids, now)` to it.
- `packages/server/src/emails/store.ts` — real store already implements
  `markDelivered(ids, now)` (line 249): `UPDATE email_pending SET delivered_at=? WHERE id=? AND
  delivered_at IS NULL`. No store change needed; the real object already satisfies the widened
  interface (structural typing).
- `packages/server/src/ai/prompts.ts` — `EMAIL_RULES` const (added in prior plan). Extend it.
- Tests: `packages/tool-emails/src/__tests__/` (tool tests) and
  `packages/server/src/ai/__tests__/prompts.test.ts` (prompt tests).
- Runtime fact: awaiting = `delivered_at IS NULL AND (urgent_pinged_at IS NULL OR <0)`. Setting
  `delivered_at` via `markDelivered` removes the row from `awaiting`/`awaiting_count` but keeps it
  in `email_pending` (still visible to period queries via `emails_list`). That is the intended
  "dismiss = out of triage queue, not deleted" semantic.

## Development Approach
- **Testing approach**: TDD — write the failing tool/prompt tests first, then implement.
- Small, focused changes; additive (new tool + interface method + prompt text).
- Out of scope (YAGNI — not requested): actually performing external actions (GitHub approve,
  pay, reply) — explicitly NOT possible, the fix is to be honest about it; bulk-dismiss of many
  ids (single `id` is enough for now); any DB schema change (reuse `delivered_at`).

## Testing Strategy
- Unit tests for `emails_dismiss`: success (marks delivered → leaves `awaiting`), error
  (missing/invalid id), and email-integration-disabled path.
- Prompt test: `EMAIL_RULES` (in both prompts) mentions `emails_dismiss` and the honesty rule
  (no faked confirmation of external actions).

## Progress Tracking
- Mark completed items `[x]` immediately. ➕ new tasks, ⚠️ blockers.

## Implementation Steps

### Task 1: Add `emails_dismiss` tool
- [x] in `packages/tool-emails/src/types.ts`, add `markDelivered(ids: number[], now: number): void;`
      to the `EmailStoreLike` interface
- [x] in `packages/tool-emails/src/index.ts`, add `createEmailsDismissTool(deps)`: param `id`
      (number, required); look up via `deps.emailStore.findByPendingId(id)`; if not found →
      `{success:false, error:...}`; else `deps.emailStore.markDelivered([id], Date.now())` and
      return `{success:true, data:{id, dismissed:true}}`. `permissionLevel:'auto'`, `provider:'all'`.
      Description (RU): пометить письмо разобранным / убрать из очереди awaiting, когда юзер
      говорит "разобрал / убери / закрой это письмо". Берёт id из emails_status/emails_list.
- [x] register `createEmailsDismissTool(deps)` in the `createTool()` return array
- [x] write tests: dismiss success (row leaves `fetchPendingUndelivered`), invalid/missing id error,
      emailStore-null disabled path
- [x] run `npm test` — must pass before next task

### Task 2: Extend EMAIL_RULES — dismiss routing + honest confirmations
- [ ] in `packages/server/src/ai/prompts.ts`, extend `EMAIL_RULES` with:
      (a) "розібрав / прибери / закрий цей лист" (and "підтверди" in the sense of «я розібрався,
      прибери») → call `emails_dismiss(id)`, then honestly "прибрав з черги";
      (b) the action the email itself REQUESTS (approve GitHub permission, оплата, відповідь) — у
      тебе НЕМАЄ tool'а її виконати: НЕ пиши "Підтверджено"/"зроблено"; скажи чесно "зроби вручну
      за посиланням, я можу лише прибрати лист з черги". Ніколи не вигадуй виконання зовнішньої дії.
- [ ] update `prompts.test.ts`: assert both prompts contain `emails_dismiss` and the honesty rule
      (e.g. a keyword like "вручну" / "не вигадуй")
- [ ] run `npm test` — must pass before next task

### Task 3: Verify acceptance & build
- [ ] verify: "разобрал это письмо" → `emails_dismiss` removes it from `awaiting`; next email-check
      shows "всё разобрано"; "подтверди" for an external action → honest "сделай вручную", no fake
- [ ] run full test suite (`npm test`) — all green
- [ ] run `npm run build` (tsc) in `packages/server` and build of `packages/tool-emails` — no type errors
- [ ] confirm additive only (no schema change; reuses `markDelivered`)

## Technical Details
- `emails_dismiss` reuses `store.markDelivered([id], now)` → `delivered_at` set → row excluded from
  `fetchPendingUndelivered` / `countPendingUndelivered`, still present for `fetchInWindow`.
- `permissionLevel:'auto'`: user explicitly invokes it; low-risk, reversible (row not deleted).

## Post-Completion
*Manual / external — no checkboxes*

**Deploy** (per flow): run ralphex on `dev`; after success `dev`→`master` + `git push origin master`;
**leave local checkout on `master`** (git-watcher only restarts when HEAD==master); supervisor
auto-restarts (or manual ws `{type:"restart"}` on port 3100).

**Manual verification (Discord):**
- "Проверь почту" → shows GitHub email. "Разобрал" / "убери это письмо" → R2 dismisses it;
  next "Проверь почту" → "всё разобрано".
- "Подтверди" (approve the GitHub permission) → R2 honestly says it can't do it on GitHub, points
  to the link, offers to remove from queue — NOT a fake "Подтверждено".
- The actual GitHub permission still needs manual approval in GitHub → Settings → Applications.
