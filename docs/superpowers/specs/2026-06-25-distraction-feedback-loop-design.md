# distractionPullback iter-2 — Feedback Loop into the Judge

**Date:** 2026-06-25
**Status:** Design — approved for planning
**Supersedes hypothesis in:** backlog item "distractionPullback iter-2 — judge учится на «Закончил»-сигналах"

## Problem

distractionPullback has been live since 2026-06-02 (`DISTRACTION_ENABLED=true`).
22 days of production data (`data/r2.db`, `distraction_evals`) reveal the real
pain, which is narrower and different from the original backlog hypothesis.

**Data: 179 evals → 16 pings (~0.7/day, declining 7→4→4→1 by week).**

Feedback on the 16 pings:

| button | meaning | count |
|--------|---------|-------|
| `back` «Возвращаюсь» | caught me, returning to work | **0** |
| `work` «Это по работе» | **false positive** | 5 |
| `done` «✅ Закончил» | was finishing | 3 |
| `snooze` «Отстань» | leave me alone | 1 |
| (ignored) | no response | 7 |

Three findings drive this design:

1. **`back` never fired once.** The success signal of the whole feature — "yes,
   you caught me drifting, I'm going back" — has zero clicks in 22 days. Every
   response was either "it's work", "I was finishing", or "go away".
2. **False positives are concentrated and high-confidence.** 3 of 5 `work`
   feedbacks are **Facebook at confidence 92–95** (the judge treats FB as a
   social feed → `distracted`, but the user uses it as a work tool). The other
   two: a work Discord channel (`#☕_общий_чат | Dedus Dev`) and a Telegram
   channel — both communication apps used for work.
3. **The learning loop is not wired at all.** The judge
   (`buildJudgePrompt`) receives only the activity timeline + the current dwell.
   It never sees past feedback. The original backlog "learns from `done`"
   hypothesis would only address 3 of 16 pings; the larger lever is feeding
   `work` feedback back so the judge stops re-flagging known-work signatures.

## Goal

Feed the user's past button feedback back into the judge, keyed by a normalized
**title signature**, so the judge stops pinging signatures the user has already
labelled "work", and softens on signatures the user habitually "finishes".

Chosen approach (confirmed during brainstorming): **feedback context injected
into the judge prompt** — not a hard pre-filter and not a per-app allowlist. The
judge keeps the final say (judge-loop), but its prompt is biased by history.

## Non-Goals (YAGNI)

- No `signature` column in the DB — computed on the fly from `window_title`, so
  the normalization can change without a backfill/migration.
- No `snooze` or `back` in the prompt — `snooze` already has the global-snooze
  mechanism (`activeSnoozeUntil`); `back` has zero occurrences. (If `back`
  starts appearing later, a follow-up iter can add positive reinforcement.)
- No button/UI changes.
- No change to the detector, daily cap, freshness, or global-snooze logic.

## Design

### 1. Title signature — new pure module

`packages/server/src/observers/title-signature.ts`

```ts
export function titleSignature(app: string, title: string | null): string;
```

Normalizes a window to a stable matching key of the form `<app>:<token>`. The
app prefix prevents cross-app collisions (a Discord channel word vs a Telegram
word normalizing the same), while the title-derived token still discriminates
work from leisure *within* one app (Chrome `facebook` vs Chrome `localhost`).
This is **not** app-level matching — the token is the discriminator; the app is
only a namespace.

The token is derived from the title:

- If the title contains a recognizable domain token (`youtube`, `facebook`,
  `twitch`, `instagram`, `reddit`, `telegram`, …) → that domain. Match is a
  lowercase substring scan over a small known-domain list plus a generic
  `\b([a-z0-9-]+)\.(com|org|net|tv|io|me)\b` host extractor.
- Else → the **first meaningful word** of the title: lowercase, after stripping
  leading bracketed counters (`(17)`, `(257)`), emoji, channel prefixes (`#`,
  `@`), and punctuation. "Meaningful" = first token of length ≥ 2 that is not a
  pure number.

If the title yields no token (empty / uninformative / `null`), the signature is
`''` (empty ⇒ no feedback matching; behavior identical to today). An empty title
does **not** fall back to `<app>:` — it returns `''` outright, so all blank-title
dwells across apps never bucket together.

Pure, deterministic, table-driven tested.

### 2. Feedback retrieval — store extension

`packages/server/src/observers/distraction-eval-store.ts`

Add one method to `DistractionEvalStore`:

```ts
/** All evals with non-null feedback at or after `since`, chronological. */
listFeedbackSince(since: number): DistractionEvalRow[];
```

SQL: `SELECT ${COLUMNS} FROM distraction_evals WHERE feedback IS NOT NULL AND
evaluated_at >= ? ORDER BY evaluated_at ASC, id ASC`.

The signature is **not** stored — the handler computes `titleSignature` over each
returned row's `(app_name, window_title)` and matches against the current dwell's
signature. This keeps normalization changeable without backfill.

### 3. Aggregation — in the handler

`packages/server/src/cognition/handlers/distractionPullback.ts`

New config dep: `feedbackLookbackDays: number` (default 60).

Before judging, build a feedback hint for the current dwell:

```ts
const sig = titleSignature(candidate.app, candidate.title);
let hint: FeedbackHint | undefined;
if (sig !== '') {
  const since = ctx.firedAt - feedbackLookbackDays * DAY_MS;
  const rows = deps.evalStore.listFeedbackSince(since);
  let work = 0, done = 0;
  for (const r of rows) {
    if (titleSignature(r.app_name, r.window_title) !== sig) continue;
    if (r.feedback === 'work') work++;
    else if (r.feedback === 'done') done++;
  }
  if (work > 0 || done > 0) hint = { signature: sig, work, done };
}
```

`hint` (possibly `undefined`) is threaded into `buildJudgePrompt` and the judge
call.

### 4. Judge prompt — `buildJudgePrompt` gains a feedback block

`packages/server/src/cognition/handlers/distractionPullback.judge.ts`

```ts
export interface FeedbackHint {
  signature: string;
  work: number; // count of past "это по работе" for this signature
  done: number; // count of past "✅ Закончил" for this signature
}

export function buildJudgePrompt(
  timeline: TimelineEntry[],
  current: CurrentDwell,
  hint?: FeedbackHint,
): { system: string; user: string };
```

The user message gains a feedback section, appended only when `hint` is present:

- **`work >= 2`** (hard bias): a strong RU line —
  > «По сигнатуре `<sig>` юзер уже N× помечал это как *работу*. НЕ ставь
  > "distracted" — верни "working", если только заголовок прямо сейчас не явная
  > бесконечная лента (Shorts/Reels/соцлента).»
- **`work == 1`** (soft): an informative RU line —
  > «По сигнатуре `<sig>` юзер 1× сказал *это работа* — учитывай это.»
- **`done >= 1`** (soft, always informative): —
  > «По сигнатуре `<sig>` юзер обычно сам доделывает и уходит — не торопись
  > пинговать.»

`work` and `done` lines can both appear. The judge retains the right to override
the hard bias on an unambiguous infinite-feed title — precision still matters,
and a single explicit override is acceptable; the default is simply shifted away
from `distracted` for known-work signatures.

`judgeDistraction(deps, timeline, current, hint?)` passes `hint` to
`buildJudgePrompt`. The handler's default judge closure threads `hint` through.

### 5. Data flow

```
detector → handler.run
  candidate (app, title, dwell)
  → titleSignature(candidate) = sig
  → evalStore.listFeedbackSince(now - 60d)
     → re-signature each row, match sig → aggregate { work, done }
  → buildTimeline (unchanged)
  → judge(timeline, current, hint)
  → verdict → shouldPing → recordEval (unchanged)
```

The force-to-`working` happens **inside the judge's decision** via the prompt
(stays a judge-loop, as chosen). Results are recorded in `distraction_evals` as
today (verdict=`working`, `pinged=0` when the bias takes effect), so the
suppression itself becomes observable data.

## Edge Cases

- **Empty signature** (blank/uninformative title): no retrieval, no hint —
  identical to current behavior. Avoids matching all blank-title rows together.
- **Signature collision**: two unrelated titles normalizing to the same first
  word (e.g. two different "Новая…"). Accepted risk — feedback is sparse and the
  bias is soft for `work==1`; `work>=2` requires repetition on the same
  signature, which collisions are unlikely to manufacture. Revisit only if data
  shows spurious suppression.
- **Normalization drift**: because signatures are recomputed at read time, an
  improved `titleSignature` immediately re-buckets historical feedback — no
  migration, no stale keys.
- **Judge failure / abort**: unchanged — `verdict='error'` recorded, never
  publishes. Hint computation is cheap and synchronous; a feedback-store read
  error must not crash `run` (wrap defensively, fall back to no hint).

## Testing

- `title-signature.test.ts` — table-driven: known domains, host extractor,
  bracketed counters `(17)`/`(257)`, emoji/`#`/`@` prefixes, pure-number tokens,
  empty/null → `''`.
- `distraction-eval-store.test.ts` — `listFeedbackSince`: window boundary,
  null-feedback filter, chronological order.
- `distractionPullback.test.ts` — aggregation: FB ×3 `work` → `hint.work===3`;
  mixed signatures don't cross-contaminate; empty signature → no hint; store
  read error → no hint, judge still runs.
- `distractionPullback.judge.test.ts` — `buildJudgePrompt` blocks: `work>=2`
  hard line present, `work==1` soft line, `done>=1` line, no block when
  `hint` undefined. Deterministic builder, no real LLM (as today).

## Acceptance Criteria

1. A current dwell whose signature has ≥2 past `work` feedbacks produces a judge
   prompt containing the hard "верни working" instruction.
2. The Facebook replay case (signature `Google Chrome:facebook`, 3× `work`) no
   longer pings in an end-to-end handler test (judge stub honoring the hard
   bias).
3. `done` feedback adds only the soft "не торопись" line, never forces a verdict.
4. Empty/uninformative titles behave exactly as before (no hint, no regression).
5. All existing distraction tests stay green; no DB migration introduced.
