# Email check: surface awaiting backlog instead of "сегодня тихо"

## Overview
When the user asks "Проверь почту" / "что в почте", the Claude agent free-forms answers
like "Сегодня новых писем нет. Тихо." — scoping to *today* and ignoring the existing
backlog of important mail that is still awaiting triage.

Root cause: the Claude system prompt (`getSystemPrompt()` in `packages/server/src/ai/prompts.ts`)
contains **no** email-handling guidance, and there is no active `prompt_overlays` row. The
model therefore decides on its own how to phrase email checks — inconsistently (on 2026-06-02
it surfaced the GitHub email; on 2026-06-03 it said "тихо"). Meanwhile a purpose-built tool
`emails_status` already exists and returns exactly the right data — `awaiting` (undelivered,
not-urgent-pinged mail of **any age**), `awaiting_count`, and the full `accounts` list — but
the agent is not told to use it.

Fix: add a small, shared email-handling rule block to both system prompts that routes
email-check intents to `emails_status` and forbids "тихо"/"писем нет" while `awaiting_count > 0`.

Verified current runtime state (data/r2.db, 2026-06-03):
- Poller healthy, both mailboxes (`imap1` ur5fot, `imap2` wagvpered) polled, 0 errors.
- `awaiting_count = 1` → GitHub permissions email (importance 3) genuinely awaits triage.
- Today's actual inbox is all importance-1 noise (correctly dropped). So the correct answer
  was "1 ждёт разбора: GitHub…", not "тихо".

Bonus: the same routing fixes the stale "Один ящик — ur5fot@gmail.com" answer, because the
agent will read `accounts_count` (=2) from `emails_status` instead of guessing.

## Context (from discovery)
- Files involved:
  - `packages/server/src/ai/prompts.ts` — `getSystemPrompt()` (Claude, prod bot) and
    `getLocalSystemPrompt()` (ollama fallback). Both currently lack email guidance.
  - `packages/server/src/ai/__tests__/prompts.test.ts` — existing prompt unit tests to extend.
- Tools already in place (no change needed): `emails_status`, `emails_list`, `emails_get`
  in `packages/tool-emails/src/index.ts`. `emails_status` already documents "ЛЮБОГО возраста"
  and exposes `awaiting`, `awaiting_count`, `accounts`, `accounts_count`.
- Patterns: `BASE_RULES` / `FINAL_STYLE_RULES` are module-level `const` strings interpolated
  into both prompts — the new `EMAIL_RULES` const follows the same pattern.
- Test runner: `npm test` → `vitest run`. Build: `tsc` (`npm run build` in packages/server).

## Development Approach
- **Testing approach**: TDD — add the failing prompt-content assertions first, then add
  `EMAIL_RULES` to make them pass.
- Single focused change; maintain backward compatibility (purely additive prompt text).
- All tests must pass before completion.
- Out of scope (YAGNI — not requested): re-scoring Google app-password alerts; fixing why the
  GitHub email never gets `delivered_at` set by the digest; any tool/DB schema change.

## Testing Strategy
- Unit tests only (prompt content). No UI/e2e in this area.
- Assert both `getSystemPrompt()` and `getLocalSystemPrompt()` contain the email-check routing
  guidance (mentions `emails_status`, the `awaiting_count > 0` rule, and `accounts_count`).

## Progress Tracking
- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.

## Implementation Steps

### Task 1: Add email-check routing guidance to system prompts
- [x] add a module-level `EMAIL_RULES` const in `packages/server/src/ai/prompts.ts` with the
      block in Technical Details below
- [x] interpolate `EMAIL_RULES` into `getSystemPrompt()` base (Claude) — placed after the tools
      line, before `FINAL_STYLE_RULES`
- [x] interpolate `EMAIL_RULES` into `getLocalSystemPrompt()` base (ollama) — near the tool-routing
      section, before `FINAL_STYLE_RULES`
- [x] add test in `prompts.test.ts`: `getSystemPrompt()` contains `emails_status`, `awaiting_count`,
      and `accounts_count`
- [x] add test in `prompts.test.ts`: `getLocalSystemPrompt()` contains the same routing guidance
- [x] run `npm test` — must pass before next task

### Task 2: Verify acceptance criteria & build
- [x] verify the prompt instructs: email-check → `emails_status`; if `awaiting_count > 0` list the
      awaiting mail of any age; never say "тихо"/"писем нет" while `awaiting_count > 0`; mailbox-count
      questions use `accounts`/`accounts_count`
- [x] run full server test suite (`npm test`) — all green (1550 tests passed)
- [x] run `npm run build` (tsc) in `packages/server` — no type errors
- [x] confirm change is additive only (no behavior change to tools/DB)

## Technical Details

`EMAIL_RULES` const (Ukrainian, matching prompt language), shared by both prompts:

```
ПОШТА:
- "перевір пошту" / "що в пошті" / "нові листи" / "чек" / "чи все розібрано" → виклич emails_status (НЕ emails_list).
  • awaiting_count > 0 → покажи ці листи (важливе, що чекає розбору, БУДЬ-ЯКОГО віку — не лише сьогодні):
    відправник + тема + важливість, найважливіші зверху. НЕ кажи "листів немає" / "тихо" / "нових немає"
    поки awaiting_count > 0.
  • awaiting_count = 0 → лише тоді коротко "важливого немає, все розібрано" (1 рядок).
- "скільки / які скриньки підключено" → бери accounts / accounts_count з emails_status, не вгадуй і не кажи "один".
- emails_list — лише коли явно просять листи за конкретний період ("за тиждень", "усе за місяць").
- emails_get — відкрити конкретний лист за id.
```

## Post-Completion
*Manual / external — no checkboxes*

**Deploy** (per project flow):
- sync `dev` ← `master` before run; after merge `dev` → `master` + `git push origin master`
  (supervisor polls `origin/master` and auto-restarts the bot so the new prompt takes effect).

**Manual verification**:
- In Discord: send "Проверь почту" → expect it to surface the awaiting GitHub email (not "тихо").
- Send "Сколько почт подключено?" → expect "2" (ur5fot + wagvpered), not "один ящик".
