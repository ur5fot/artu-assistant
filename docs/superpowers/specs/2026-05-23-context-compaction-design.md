# Context Compaction (4C) — design

## Problem

R2 chat history grows unbounded. Current behavior in
[packages/server/src/routes/chat.ts:25-76](../../packages/server/src/routes/chat.ts#L25-L76):
when the conversation exceeds `CHAT_CONTEXT_BUDGET_CHARS=60000`, the oldest
turns are silently dropped before sending to Claude. The model loses
context from earlier in the same Discord session and "forgets" decisions,
plans, and ongoing threads.

**Goal:** preserve meaning when truncating, not just bytes.

## Non-goals

- Cost optimization (would imply lowering the budget — opposite direction)
- Avoiding context-overflow at the 200k Claude window (we're at ~7.5% of it)
- UI for browsing topics (Discord-only, no place to render)
- Cross-session boundaries (a Discord DM is one continuous stream)
- Merging or splitting topics manually

## Mental model: human memory layers

| Layer | Span | Mechanism | R2 analog |
|-------|------|-----------|-----------|
| Working memory | minutes | Verbatim, ~7 items | Last turns of current open topic |
| Episodic | hours-days | Episodes with detail, fade | Finalized topic summaries in prompt |
| Semantic | years | Extracted facts | 4A memory_facts (existing) |
| Consolidation | sleep/idle | Replay, strengthen, prune | Background finalizer job |
| Associative recall | continuous | Current cue triggers old | 4A vector search (existing) |

The design is a hybrid: reactive compaction at budget threshold +
background consolidation + multi-tier storage + associative recall.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    chat_messages (raw, retained)             │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ├─ open topic       → verbatim in prompt (last 20 turns)
                     │
                     ├─ finalized topics → summaries ranked by importance,
                     │                     fill X% of budget (adaptive)
                     │
                     └─ overflow         → only via memory_vec recall
                                           (existing 4A vector search)
```

Two new modules plus one prompt-builder rewrite. Memory pipeline (4A)
already does facts extraction + vector recall; we feed it more material.

### 1. Topic detector

New module: `packages/server/src/topics/detector.ts`.

**Boundary rules (heuristic, no per-message LLM):**

- `time_gap > 2h` from previous turn → close current topic, start new
- Server restart: any `status='open'` topic with `ended_at < now - 2h`
  → autoclose on startup (handles dropped sessions cleanly)
- No explicit user-pivot detection in v1 (YAGNI; time-gap covers the
  common case)

**Invariants:**

- At most one `status='open'` topic at any time
- Every `chat_message` is linked to exactly one topic via
  `chat_topic_messages`
- A burst (coalesced Discord messages) maps to one turn → one link
- Topic boundaries are derived per-account / per-source: in practice
  R2's `chat_messages` are global, but the algorithm treats source as a
  partition key in case of future multi-channel use

### 2. Topic finalizer

New module: `packages/server/src/topics/finalizer.ts`. Background job
ticks every 10 min via existing `cognitionService` scheduling pattern,
mirroring `morningBrief` and `emailDigest` handlers.

**Per tick:**

1. Find topics with `status='closed' AND ended_at < now - 10min` (buffer
   for late additions in case of clock skew)
2. Collect their linked turns from `chat_messages`
3. Strip large tool-call JSON before sending to LLM (replace with
   `"<tool: code_task — 12 iterations, success>"` style placeholders;
   keeps summary focused on conversation flow, not bytes)
4. Single Claude Haiku call (uses existing `MEMORY_EXTRACT_MODEL_CLAUDE`
   client) returning JSON:
   ```json
   {
     "label": "5-7 words, e.g. 'Emails MIME decoding fix'",
     "summary": "300-500 chars covering decisions, outcomes, key facts",
     "importance": 1-10
   }
   ```
5. Persist on the topic row, embed `summary` via existing
   `safeEmbedDocument` from memory service, store in `memory_vec` with
   `kind='topic_summary'` so vector recall returns these naturally
6. Extract facts from the topic turns through the existing
   `extractFacts` pipeline (free integration with 4A memory)
7. Set `topic.status='finalized'`

**Importance scoring criteria** (in the Haiku prompt):

- Plans/decisions made → 7-9
- Bug fixes / deployed code → 6-8
- Casual chat / one-off question → 2-4
- Unfinished/aborted work → 5
- Pure error retries → 1-2

The score is opaque to the system; only used for prompt ranking. No
attempt to learn or recalibrate.

### 3. Prompt builder

Rewrites `truncateMessages` in `packages/server/src/routes/chat.ts:25` as
`buildCompactedPrompt`. Called from the same site (chat route) and
preserves the existing return type `MessageParam[]`.

**Algorithm:**

```
budget = CHAT_CONTEXT_BUDGET_CHARS  (default 60000)
recent_share = 0.5     // half the budget reserved for verbatim
summary_share = 0.4    // 40% for ranked topic summaries
emergency_buffer = 0.1 // 10% headroom for system + memory prefix already injected

step 1: collect last N verbatim turns from current open topic until
        chars used >= recent_share * budget OR no more turns
        (N is dynamic, not a fixed count — adapts to turn length)

step 2: list finalized topics, sort by (importance DESC, ended_at DESC),
        prepend their summaries one by one to a "Recent topics" block
        until block size >= summary_share * budget
        Topics that don't fit are NOT prepended — they remain
        recoverable via memory_vec recall in step 4 of the existing
        4A buildContextPrefix

step 3: assemble the final messages[]:
          [system-suffix: "Recent topics:\n - [label1] summary1\n ..."]
          [verbatim user/assistant turns from step 1]
          [current user message]

step 4: if total > budget (emergency — rare): trigger reactive Haiku
        meta-summary call on the LOWEST importance summaries (collapse
        N into 1) and retry from step 2
```

**Key choices:**

- `recent_share + summary_share = 0.9` leaves 10% buffer because the
  existing 4A `buildContextPrefix` already injects facts + recall hits
  into the user message — that consumes budget invisible to this builder
- Verbatim turns are walked NEWEST-first, kept until share is full;
  same orphan-assistant strip as today
- `ended_at DESC` as secondary sort ensures equal-importance topics
  prefer recent

### 4. Database schema

New tables (added via migration in [packages/server/src/db.ts](../../packages/server/src/db.ts)):

```sql
CREATE TABLE IF NOT EXISTS chat_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,                                   -- NULL until finalized
  summary TEXT,                                 -- NULL until finalized
  importance INTEGER,                           -- NULL until finalized; 1-10
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                             -- NULL while open
  status TEXT NOT NULL CHECK (status IN ('open','closed','finalized')),
  source TEXT,                                  -- 'discord' / 'web' / etc
  finalized_at INTEGER                          -- timestamp of Haiku call
);
CREATE INDEX idx_chat_topics_status ON chat_topics(status, ended_at);
CREATE INDEX idx_chat_topics_finalized ON chat_topics(finalized_at);

CREATE TABLE IF NOT EXISTS chat_topic_messages (
  topic_id INTEGER NOT NULL REFERENCES chat_topics(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,                     -- chat_messages.message_id
  PRIMARY KEY (topic_id, message_id)
);
CREATE INDEX idx_chat_topic_messages_msg ON chat_topic_messages(message_id);
```

`memory_vec` gains a new `kind` value `'topic_summary'`. No schema change
since `kind` is already a free-form TEXT column.

### 5. Wiring

- `saveMessage` in `db.ts` → after insert, call `topicDetector.assign(msg)`
  which either links to current open topic or creates a new one
- Server bootstrap (`index.ts`) → on startup, autoclose any orphan
  `status='open'` topic with stale `ended_at`
- `cognitionService.register(createTopicFinalizerHandler({...}))` next to
  the existing `morningBrief` and `emailDigest` handlers (Phase 4F's
  cognition layer is the natural home)
- `chat.ts` route → swap `truncateMessages` for `buildCompactedPrompt`

## Data flow

```
discord msg in
  → saveMessage(chat_messages)
  → topicDetector.assign:
       gap = now - last_message_at
       if gap > 2h OR no open topic:
         close current (status=closed, ended_at=last_message_at)
         insert new chat_topics(status=open, started_at=now)
       insert chat_topic_messages(current_topic, msg)

(every 10 min, background)
finalizer tick
  → SELECT * FROM chat_topics WHERE status='closed' AND ended_at < now-10min
  → for each: gather turns → strip tool JSON → Haiku → embed → store
  → set status=finalized

chat request
  → buildCompactedPrompt:
      open topic turns verbatim (50% budget)
      + finalized topics ranked by importance (40% budget)
  → Claude API call
```

## Edge cases

- **Tool-heavy turns:** raw `tool_calls` JSON is replaced with short
  placeholders before sending to Haiku in the finalizer and before
  rendering verbatim turns in the prompt builder. Reduces noise and
  budget burn without losing the fact "tool X was used."
- **Discord burst coalescing:** the existing burst-coalesce logic on the
  bot side produces one effective turn per burst → one link row. No
  change needed.
- **Server restart with open topic:** on boot, find any `status='open'`
  topic whose last message is older than 2h, mark closed. The next tick
  picks it up for finalization normally.
- **Finalizer failure (Haiku down):** topic stays at `status='closed'`,
  next tick retries. Per-topic error counter — after 5 failed attempts,
  mark `status='finalized'` with `label='[finalization failed]'` and
  no summary, so the topic doesn't block the queue forever. Logged.
- **Concurrent finalizer ticks:** the existing `cognitionService`
  serializes handler runs; no extra lock needed.
- **Late message in a closed topic:** if a delayed Discord message lands
  after gap closure, it creates a NEW topic. We don't backfill — keeping
  the rule simple ("topics are immutable once closed").
- **Empty topic:** if a topic gets closed with zero linked messages
  (shouldn't happen but defensive), finalizer skips and marks
  `status='finalized'` with a placeholder label.

## What we are NOT building (YAGNI)

- LLM-driven topic-pivot detection on every message
- Hierarchical summaries (summary of summaries)
- Topic merge / split tools
- UI for browsing topics
- Per-topic retention policies (everything follows existing
  `CHAT_HISTORY_RETENTION_DAYS`)
- Importance-driven retention decay (only ranking)
- Cross-session boundaries

## Open implementation details (resolved during writing-plans)

- Exact Haiku prompt template for finalizer
- Per-tier char shares as constants vs env-configurable
- Migration order vs the existing `email_pending` migration
- Test fixtures for topic-detector boundary cases

## Risks

- **Wrong gap boundary in practice:** 2h may merge unrelated topics if
  R2-sessions run that long without break, or split related ones if user
  steps away. Mitigation: gap is a constant in detector — easy to tune
  later; topic IDs are stable so a tuning change doesn't break recall.
- **Haiku summarization quality:** if labels are bad, prompt prefix
  becomes noise. Mitigation: include a fixed example in the prompt;
  fall back to first 50 chars of first turn as label if Haiku returns
  garbage.
- **Memory_vec pollution:** `kind='topic_summary'` embeddings join chat
  and fact embeddings. If they crowd recall results, vector search
  may downgrade chat-msg hits. Mitigation: kind filter exists; can be
  tuned in `buildContextPrefix` if needed.
- **Burst coalescing edge case:** if Discord bot ever emits sub-turn
  events, topic_detector might see them as separate messages within the
  same time window — fine, all attach to same open topic. No risk.
