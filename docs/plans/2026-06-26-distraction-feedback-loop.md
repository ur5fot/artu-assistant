# distractionPullback iter-2 — Feedback Loop into the Judge

## Overview

Feed the user's past button feedback (`work`, `done`) back into the distraction
judge, keyed by a normalized title signature, so the judge stops pinging
signatures the user already labelled "work" and softens on signatures the user
habitually finishes. Closes the Facebook conf-95 false-positive class (3 of 5
`work` feedbacks in 22 days of prod data) and wires the previously-missing
feedback loop (the judge currently never sees past feedback).

Design spec: `docs/superpowers/specs/2026-06-25-distraction-feedback-loop-design.md`.

Approach (chosen in brainstorming): feedback injected into the judge **prompt**,
not a hard pre-filter or per-app allowlist. The judge keeps final say; its prompt
is biased by history. `work≥2` on a signature → hard bias to `working`; `work==1`
soft; `done≥1` informative only.

## Context (from discovery)

- Files/components involved:
  - `packages/server/src/observers/distraction-eval-store.ts` — eval store; add `listFeedbackSince`.
  - `packages/server/src/observers/title-signature.ts` — NEW pure module.
  - `packages/server/src/cognition/handlers/distractionPullback.judge.ts` — `buildJudgePrompt`/`judgeDistraction` gain optional `FeedbackHint`.
  - `packages/server/src/cognition/handlers/distractionPullback.ts` — handler computes signature, aggregates feedback, threads hint.
- Related patterns found:
  - Eval store uses prepared statements + a `COLUMNS` constant (see `selectInWindow`).
  - Judge prompt is a pure deterministic builder; tests stub the LLM, never call it.
  - Handler already builds a timeline (`buildTimeline`) and records evals via `deps.evalStore.recordEval`.
- Dependencies identified: `better-sqlite3`, `@anthropic-ai/sdk`. No new deps. No DB migration (signature computed on the fly).

## Development Approach

- **Testing approach**: TDD (tests first) — matches existing distraction modules.
- Complete each task fully before the next; small focused changes.
- **Every task includes tests**; all tests pass before starting the next task.
- No DB migration; backward compatible (hint is optional, absent ⇒ today's behavior).

## Testing Strategy

- **Unit tests**: required per task. Vitest, colocated `__tests__` dirs as in repo.
- **E2E**: none for this backend feature (Discord-only, no UI e2e harness).

## Progress Tracking

- Mark completed items `[x]` immediately.
- ➕ for newly discovered tasks, ⚠️ for blockers.
- Keep this file in sync with actual work.

## What Goes Where

- Implementation Steps: code + tests in `packages/server`.
- Post-Completion: deploy via the standard sync→ralphex→master flow; live verification on real Haiku.

## Implementation Steps

### Task 1: Title signature pure module

- [x] write tests `packages/server/src/observers/__tests__/title-signature.test.ts` (table-driven): known domains (youtube/facebook/twitch/instagram/reddit/telegram), generic host extractor (`foo.com`), bracketed counters `(17)`/`(257)` stripped, emoji/`#`/`@` prefixes stripped, pure-number token skipped, empty/null/uninformative → `''`, output shape `<app>:<token>`
- [x] create `packages/server/src/observers/title-signature.ts` exporting `titleSignature(app: string, title: string | null): string`
- [x] implement domain detection (known-domain substring scan + `\b([a-z0-9-]+)\.(com|org|net|tv|io|me)\b` host extractor) then first-meaningful-word fallback (strip leading bracketed counters, emoji, `#`/`@`, punctuation; first token length ≥2 and not all-digits)
- [x] empty/uninformative title returns `''` outright (no `<app>:` fallback)
- [x] run `npm test` (server) — must pass before Task 2

### Task 2: Store — listFeedbackSince

- [x] write tests in `packages/server/src/observers/__tests__/distraction-eval-store.test.ts`: returns only `feedback IS NOT NULL` rows, respects `since` lower bound (boundary inclusive), chronological `ASC` order
- [x] add `listFeedbackSince(since: number): DistractionEvalRow[]` to the `DistractionEvalStore` interface
- [x] implement with a prepared statement reusing `COLUMNS`: `WHERE feedback IS NOT NULL AND evaluated_at >= ? ORDER BY evaluated_at ASC, id ASC`
- [x] run `npm test` — must pass before Task 3

### Task 3: Judge prompt — FeedbackHint block

- [x] write tests in `packages/server/src/cognition/__tests__/handlers/distractionPullback.judge.test.ts`: `hint` undefined → no feedback block; `work>=2` → hard "верни working" instruction present (mentions signature); `work==1` → soft "учитывай" line only (no hard instruction); `done>=1` → "не торопись" line; `work` and `done` lines can co-occur
- [x] export `interface FeedbackHint { signature: string; work: number; done: number }` from `distractionPullback.judge.ts`
- [x] extend `buildJudgePrompt(timeline, current, hint?)` to append the RU feedback section per the spec thresholds (work≥2 hard, work==1 soft, done≥1 informative); judge retains override right on explicit infinite-feed titles (wording from spec)
- [x] extend `judgeDistraction(deps, timeline, current, hint?)` to thread `hint` into `buildJudgePrompt`
- [x] run `npm test` — must pass before Task 4

### Task 4: Handler — signature aggregation + hint threading

- [x] write tests in `packages/server/src/cognition/__tests__/handlers/distractionPullback.test.ts`: FB ×3 `work` rows in store → judge receives `hint.work===3` with the FB signature; rows of a different signature do not contribute (no cross-contamination); empty-signature current dwell → no hint passed; `evalStore.listFeedbackSince` throwing → no hint, judge still runs (defensive)
- [x] add `feedbackLookbackDays: number` to `DistractionHandlerDeps` (default 60 wired at construction site)
- [x] in `run`, after computing `candidate`, compute `sig = titleSignature(candidate.app, candidate.title)`; if non-empty, call `listFeedbackSince(firedAt - feedbackLookbackDays*DAY_MS)`, re-signature each row, aggregate `{work, done}` for matching sig, build `hint` when `work>0 || done>0`
- [x] wrap the feedback read defensively (try/catch → undefined hint) so a store error never crashes `run`
- [x] pass `hint` into the `judge(...)` call (extend the `DistractionJudge` type + default closure signature)
- [x] run `npm test` — must pass before Task 5

### Task 5: Wire default + verify acceptance criteria

- [x] set `feedbackLookbackDays: 60` at the handler construction/registration site (locate where `createDistractionHandler` is wired into cognition) — wired in `packages/server/src/index.ts` via `envInt(DISTRACTION_FEEDBACK_LOOKBACK_DAYS, 60, 1, 365)`
- [x] verify acceptance criteria from spec: (1) sig with ≥2 work → hard instruction in prompt; (2) FB replay (`Google Chrome:facebook`, 3× work) → no ping end-to-end; (3) done-only → soft line, never forces; (4) empty titles unchanged; (5) no migration, existing distraction tests green — all covered by Task 1–4 test suites, 1887/1887 green
- [x] run full server test suite — must pass (1887 passed)
- [x] run linter (`npm run lint` in server) — no `lint` script in repo; ran `tsc --noEmit` instead, clean

### Task 6: Documentation

- [ ] update `AGENTS.md` distraction section (or the module's doc block) noting the feedback-loop signature + thresholds if a relevant section exists
- [ ] move design spec reference / note iter-2 in any distraction overview doc if present

## Technical Details

- Signature key: `<app>:<token>`. Token = domain (known list or host regex) else first meaningful title word (lowercase, counters/emoji/`#`/`@`/punct stripped, length ≥2, not all-digits). Empty title → `''` (no matching).
- Aggregation: re-signature each `listFeedbackSince` row at read time (no stored signature column) → counts per matching signature.
- Thresholds: `work≥2` hard bias to `working`; `work==1` soft; `done≥1` informative.
- Lookback: 60 days. Default `feedbackLookbackDays = 60`.
- No schema change; `feedback` column already exists and is populated by button handlers.

## Post-Completion

**Manual verification**:
- Live check on real Haiku: trigger a known-work signature (e.g. Facebook used for work) and confirm no ping after ≥2 prior `work` feedbacks exist; confirm an unambiguous Shorts/Reels title still pings.

**Deploy**:
- Standard flow: sync dev←master, run ralphex, dev→master, `git push origin master` (supervisor polls origin/master, auto-restart).
