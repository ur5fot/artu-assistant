# Context Compaction (4C) — topic clustering implementation

**Spec:** [docs/superpowers/specs/2026-05-23-context-compaction-design.md](../specs/2026-05-23-context-compaction-design.md)

## Overview

Replace dumb tail-truncation in
[packages/server/src/routes/chat.ts:25-76](../../packages/server/src/routes/chat.ts#L25-L76)
with topic-clustered compaction. Background finalizer summarizes closed
topics via Claude Haiku, stores summaries with embeddings in the existing
`memory_vec` table, and the prompt builder serves recent verbatim turns +
ranked finalized summaries to Claude up to the budget. Older summaries
remain recoverable through 4A vector recall.

## Context (from discovery)

**Files involved:**
- [packages/server/src/db.ts](../../packages/server/src/db.ts) — DB schema, migrations live alongside existing CREATE TABLE blocks
- [packages/server/src/db.ts:342](../../packages/server/src/db.ts#L342) — `getChatHistoryLimit`, `saveMessage` pattern
- [packages/server/src/routes/chat.ts:25-76](../../packages/server/src/routes/chat.ts#L25-L76) — `truncateMessages` to be replaced
- [packages/server/src/routes/chat.ts:403-410](../../packages/server/src/routes/chat.ts#L403-L410) — call site
- [packages/server/src/index.ts](../../packages/server/src/index.ts) — server bootstrap, `cognitionService.register` calls
- [packages/server/src/cognition/handlers/morningBrief.ts](../../packages/server/src/cognition/handlers/morningBrief.ts), [emailDigest.ts](../../packages/server/src/cognition/handlers/emailDigest.ts) — handler pattern to mirror
- [packages/server/src/memory/service.ts](../../packages/server/src/memory/service.ts) — exposes `safeEmbedDocument`, `extractFacts`; `buildContextPrefix` does vector recall
- [packages/server/src/memory/vectorStore.ts](../../packages/server/src/memory/vectorStore.ts) — `vectorSearch` filters by `kind`

**Patterns found:**
- Cognition handlers are pure: `{ name, async trigger, async run(ctx) }`
- Stores are plain factory functions: `createXStore({ db }): XStore`
- Tests use `vitest` with table-driven cases; mocks for IMAP / Claude / Ollama follow existing harnesses in `__tests__/`
- Memory service exposes `safeEmbedDocument` (text → Buffer | null) and `extractFacts` (textProvider → facts[])
- Migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` checked by `PRAGMA table_info`)

**Dependencies identified:**
- None new — Claude Haiku already wired via `MEMORY_EXTRACT_MODEL_CLAUDE`, `safeEmbedDocument` already runs Voyage

## Development Approach

- **Testing approach**: Regular (code first, tests per task)
- Complete each task fully before next
- Small focused changes
- **Every task includes new/updated tests**
- All tests pass before next task — no exceptions
- Update this plan if scope shifts

## Testing Strategy

- **Unit tests** required per task
- No e2e: feature is server-internal
- Mock `Date.now`, message store, Haiku client, embedder
- Use existing test fixtures for chat_messages where possible
- Integration test for full chat → topic → finalizer → prompt path in Task 6

## Progress Tracking

- `[x]` immediately on completion
- ➕ for newly discovered tasks
- ⚠️ for blockers

## What Goes Where

- **Implementation Steps** (`[ ]`): all code, tests, schema, docs in this repo
- **Post-Completion** (informational): no manual steps; finalizer auto-processes existing chat history on first tick after deploy (treats every message as "no current topic" → bootstraps topics from existing data)

## Implementation Steps

### Task 1: DB schema + topic store

- [x] add `chat_topics` and `chat_topic_messages` tables in [packages/server/src/db.ts](../../packages/server/src/db.ts) following the existing `CREATE TABLE IF NOT EXISTS` pattern. Include indexes from spec §4:
  ```sql
  CREATE TABLE IF NOT EXISTS chat_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    summary TEXT,
    importance INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('open','closed','finalized')),
    source TEXT,
    finalized_at INTEGER,
    failure_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_chat_topics_status ON chat_topics(status, ended_at);
  CREATE INDEX IF NOT EXISTS idx_chat_topics_finalized ON chat_topics(finalized_at);
  CREATE TABLE IF NOT EXISTS chat_topic_messages (
    topic_id INTEGER NOT NULL REFERENCES chat_topics(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    PRIMARY KEY (topic_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_topic_messages_msg ON chat_topic_messages(message_id);
  ```
  - `failure_count` added beyond spec §4 to support the 5-retry rule in spec §"Finalizer failure"; tracked explicitly so it survives restarts.
- [x] create `packages/server/src/topics/store.ts` with `TopicStore` interface:
  - `getOpenTopic(source: string | null): TopicRow | null`
  - `createOpen(now: number, source: string | null): TopicRow`
  - `closeOpen(topicId: number, endedAt: number): void`
  - `linkMessage(topicId: number, messageId: string): void`
  - `listClosedReadyForFinalize(cutoff: number, limit: number): TopicRow[]` (status='closed' AND ended_at < cutoff)
  - `finalize(topicId: number, label: string, summary: string, importance: number, now: number): void`
  - `markFinalizationFailure(topicId: number): number` — increments failure_count, returns new count
  - `markFinalizationGiveUp(topicId: number, now: number): void` — sets status='finalized', label='[finalization failed]', summary=null, importance=0
  - `findStaleOpen(cutoff: number): TopicRow[]` — for startup autoclose
  - `getTopicMessages(topicId: number): ChatMessageRow[]` — joins chat_topic_messages → chat_messages
  - `listFinalized(limit: number): TopicRow[]` — for prompt builder
- [x] write `packages/server/src/topics/__tests__/store.test.ts` table-driven:
  - createOpen sets status='open', started_at, source
  - getOpenTopic returns the open topic when one exists, null when none, errors on multiple (invariant)
  - closeOpen transitions to status='closed', sets ended_at
  - linkMessage idempotent (PK conflict ignored)
  - listClosedReadyForFinalize honors cutoff and limit
  - finalize sets all fields + finalized_at
  - markFinalizationFailure increments, returns new count
  - markFinalizationGiveUp transitions correctly
  - findStaleOpen returns open topics whose last message is older than cutoff (joins chat_topic_messages)
  - getTopicMessages returns messages in timestamp order
- [x] run server tests — must pass before Task 2

### Task 2: Topic detector + saveMessage hook

- [x] create `packages/server/src/topics/detector.ts` with `createTopicDetector({ store, gapMs })`:
  - exposes `assign(message: { messageId, timestamp, source }): void`
  - rule: if no open topic for source OR `message.timestamp - lastTimestamp > gapMs` → close current (if any), create new
  - tracks `lastTimestamp` per source in a private Map (cheaper than re-querying store on every message)
  - on startup, populates the Map from `store.getOpenTopic` for each known source
  - `gapMs` constant: `const TOPIC_GAP_MS = 2 * 60 * 60 * 1000` (2 hours per spec)
- [x] wire detector into [packages/server/src/db.ts](../../packages/server/src/db.ts) `saveMessage`:
  - after INSERT INTO chat_messages, call `topicDetector.assign({ messageId, timestamp, source })`
  - detector is dependency-injected through a module-level setter `setTopicDetector(d: TopicDetector | null)` so DB layer stays testable without topic dependency
- [x] in [packages/server/src/index.ts](../../packages/server/src/index.ts) construct topic store + detector and call `setTopicDetector(detector)` before any chat traffic. Order: after `getDb()` is initialized, before Discord bot start.
- [x] write `packages/server/src/topics/__tests__/detector.test.ts`:
  - first message with no open topic → creates new topic, links message
  - second message within gap → links to same topic
  - message after gap → closes old, creates new, links to new
  - multiple sources → independent topics
  - constructor populates lastTimestamp from getOpenTopic on init (no false-new-topic on restart)
- [x] update existing [packages/server/src/__tests__/db.test.ts](../../packages/server/src/__tests__/db.test.ts) if it asserts saveMessage signature; add coverage that detector hook fires when set, no-op when null
- [x] run server tests — must pass before Task 3

### Task 3: Server startup autoclose for stale open topics

- [x] add `autocloseStaleOpenTopics(store, gapMs, now)` in `packages/server/src/topics/startup.ts`:
  - calls `store.findStaleOpen(now - gapMs)`
  - for each: `store.closeOpen(topic.id, now - gapMs)` (set ended_at to the cutoff so finalizer treats it as having ended at the threshold, not at restart time)
  - returns count for logging
- [x] call `autocloseStaleOpenTopics(topicStore, TOPIC_GAP_MS, Date.now())` in [packages/server/src/index.ts](../../packages/server/src/index.ts) during bootstrap, log `[topics] autoclosed N stale open topics`
- [x] write `packages/server/src/topics/__tests__/startup.test.ts`:
  - autoclose returns count, closes the topic, sets ended_at to cutoff
  - topic with no messages still closes (defensive)
  - topic with a fresh message (within gap) is NOT closed
- [x] run server tests — must pass before Task 4

### Task 4: Finalizer (Haiku + facts + embedding)

- [x] create `packages/server/src/topics/finalizer.ts` exporting `createTopicFinalizerHandler(deps)`:
  ```ts
  interface Deps {
    store: TopicStore;
    memoryService: MemoryService;  // for safeEmbedDocument + facts pipeline
    anthropic: Anthropic;           // for Haiku call
    extractorModel: string;         // MEMORY_EXTRACT_MODEL_CLAUDE
    bufferMs: number;               // 10 min default
    finalizeBatch: number;          // 5 default
    maxFailures: number;            // 5 default
  }
  ```
  - returns `Handler { name: 'topicFinalizer', trigger, run }` matching cognition Handler shape from [packages/server/src/cognition/types.ts](../../packages/server/src/cognition/types.ts)
  - `trigger`: returns true if `store.listClosedReadyForFinalize(now - bufferMs, finalizeBatch).length > 0`
  - `run`:
    1. fetch closed topics ready for finalize
    2. for each: gather messages via `store.getTopicMessages`
    3. strip tool_calls JSON → `<tool: ${name} — ${status}>` placeholder
    4. build Haiku prompt (see Technical Details below)
    5. call `anthropic.messages.create` with model=extractorModel, max_tokens=600, single user message
    6. parse JSON response `{ label, summary, importance }` with try/catch
    7. on parse failure → `store.markFinalizationFailure(topic.id)`; if count >= maxFailures → `markFinalizationGiveUp`
    8. on success: `store.finalize(...)`, then `memoryService.safeEmbedDocument(summary)` → store via `memoryService.indexTopicSummary({ topicId, label, summary, embedding, importance, finalizedAt })` (new method, see below)
    9. also call `memoryService.extractFactsFromConversation(messages)` (new wrapper around existing `extractFacts`) to feed 4A
  - returns `{ publish: false }` or `{ skip: false }` — finalizer is silent, no Discord publish
- [x] extend `MemoryService` in [packages/server/src/memory/service.ts](../../packages/server/src/memory/service.ts):
  - new method `indexTopicSummary(params: { topicId, label, summary, embedding, importance, finalizedAt }): Promise<void>` — inserts into `memory_vec` with `kind='topic_summary'`, content=`label + '\n' + summary`, foreign reference = topicId via existing `entityId` column if present (or new column if not)
  - new method `extractFactsFromConversation(messages: ChatMessage[]): Promise<void>` — concatenates user/assistant turns, calls existing `extractFacts`, inserts into `memory_facts`. Reuse existing `runIndexTurn` extraction logic; factor out shared code.
- [x] write `packages/server/src/topics/__tests__/finalizer.test.ts`:
  - trigger returns true when ready topics exist, false when none
  - run finalizes one topic: Haiku returns valid JSON → store.finalize called with parsed values, indexTopicSummary called, extractFactsFromConversation called
  - run finalizes multiple topics in one tick (up to finalizeBatch)
  - Haiku returns malformed JSON → markFinalizationFailure called, count incremented; topic stays at status='closed'
  - Haiku throws → same failure path
  - 5th consecutive failure → markFinalizationGiveUp, status='finalized' with placeholder label
  - tool_calls in messages are replaced with placeholders before Haiku prompt
- [x] write `packages/server/src/memory/__tests__/service-topic.test.ts`:
  - indexTopicSummary inserts into memory_vec with kind='topic_summary'
  - extractFactsFromConversation calls extractFacts with concatenated turns, inserts facts
- [x] register handler in [packages/server/src/index.ts](../../packages/server/src/index.ts) next to `morningBrief` and `emailDigest`: `cognitionService.register(createTopicFinalizerHandler({...}))`
- [x] run server tests — must pass before Task 5

### Task 5: Prompt builder (replaces truncateMessages)

- [x] create `packages/server/src/routes/chat-prompt.ts` with `buildCompactedPrompt(params)`:
  ```ts
  interface BuildParams {
    messages: Array<{ role: string; content: string; timestamp?: number; topicId?: number }>;
    budget: number;
    store: TopicStore;
    now: number;
    recentShare?: number;   // default 0.5
    summaryShare?: number;  // default 0.4
  }
  interface BuildResult {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;  // ready for Claude
    summaryPrefix: string | null;  // injected as a system-suffix
  }
  ```
  - walks `messages` NEWEST-first, keeps while charCount <= budget * recentShare; strips leading orphan-assistant same as existing `truncateMessages`
  - last message hard-cap behavior (single oversized paste) preserved: if last message > entire `recentShare * budget`, truncate with `[...truncated]\n` prefix
  - `summaryPrefix` built from `store.listFinalized(limit: 20)`, sorted by `importance DESC, finalized_at DESC`, prepending labels+summaries one at a time until total > `budget * summaryShare`; topics not included are silently dropped (recoverable via memory recall)
  - format of prefix:
    ```
    === Recent topics (older context, summarized) ===
    [2026-05-23 14:00] Emails MIME decoding fix: <summary>
    [2026-05-22 17:00] Memory provider switch: <summary>
    === End topics ===
    ```
- [x] update [packages/server/src/routes/chat.ts:403-410](../../packages/server/src/routes/chat.ts#L403-L410) to call `buildCompactedPrompt` instead of `truncateMessages`; inject `summaryPrefix` as a synthetic system suffix that gets appended to the system prompt (NOT as a chat turn — keeps user/assistant alternation clean)
- [x] keep `truncateMessages` exported for now (fallback path if topicStore is null in tests) but route uses `buildCompactedPrompt`
- [x] write `packages/server/src/routes/__tests__/chat-prompt.test.ts`:
  - empty history → empty messages, null summaryPrefix
  - history fits in budget → all messages kept, no summaries pulled
  - history exceeds recent share → oldest messages dropped, summaries fill
  - summaries exceed summary share → only highest-importance + newest kept
  - oversized last message → truncated with marker (existing behavior preserved)
  - leading orphan-assistant after trim → stripped
  - summaryPrefix format matches expected template exactly (lock the format)
- [x] update [packages/server/src/routes/__tests__/chat.test.ts](../../packages/server/src/routes/__tests__/chat.test.ts) (existing tests for truncate behavior) — should still pass because oversized + orphan behavior identical
- [x] run server tests — must pass before Task 6

### Task 6: Acceptance + end-to-end integration

- [x] write `packages/server/src/topics/__tests__/integration.test.ts` covering the full path:
  - seed `chat_messages` with 50 messages across two time-separated bursts (gap > 2h)
  - bootstrap topic detector → 2 topics created
  - close first topic (simulating gap) → status='closed'
  - run finalizer tick with mocked Haiku → 1 topic finalized, summary in memory_vec
  - call buildCompactedPrompt with budget such that summary fits → output contains summaryPrefix with finalized topic label
  - call buildContextPrefix from memory service — verify topic_summary embedding is searchable
- [x] verify acceptance criteria from spec:
  - "old turns produce summaries, not silent drops" — covered by integration test
  - "finalizer 5-failure giveup" — covered in Task 4 tests
  - "tool_calls don't poison summaries" — covered in Task 4 tests
  - "stale open topic on restart" — covered in Task 3 tests
- [x] run full repo test suite: `npm test` — all tests must pass
- [x] run `npx tsc --noEmit -p packages/server/tsconfig.json` — clean
- [x] manual smoke: start server, send 3 Discord messages with > 2h between #2 and #3 (use sql to backdate timestamps if testing locally), wait 10 min for finalizer tick, verify topic finalized in DB, verify next chat sees summaryPrefix in logs (skipped — not automatable, deferred to post-deploy verification per Post-Completion section)

### Task 7: [Final] Update documentation

- [x] add a short "Context compaction" section to [README.md](../../README.md) explaining the topic-clustering model and the 2h gap rule
- [x] add JSDoc block at top of `topics/detector.ts` explaining gap rule + why heuristic not LLM
- [x] add JSDoc to `topics/finalizer.ts` explaining the failure-count semantics and that summaries flow into existing 4A memory_vec

## Technical Details

**Haiku finalizer prompt template** (used in Task 4):

```
You will receive a transcript of a conversation between a user and an AI assistant. Produce a concise summary capturing decisions, outcomes, and key facts. Skip pleasantries and verbose tool output.

Return ONLY valid JSON in this exact shape (no markdown fence, no prose):
{"label": "5-7 words", "summary": "300-500 characters", "importance": 1-10}

Importance scale:
- 7-9: plans/decisions made, code shipped, bugs fixed
- 4-6: ongoing investigation, partial work
- 1-3: chitchat, one-off question, error retry

Transcript:
<turns concatenated, tool_calls replaced with placeholders>
```

**Topic linking on message insert:**

```
saveMessage(msg)
  → DB INSERT chat_messages
  → topicDetector.assign(msg):
       openTopic = openTopicsMap.get(msg.source)
       if !openTopic OR (msg.timestamp - lastTimestamp[msg.source]) > TOPIC_GAP_MS:
         if openTopic: store.closeOpen(openTopic.id, lastTimestamp[msg.source])
         openTopic = store.createOpen(msg.timestamp, msg.source)
         openTopicsMap.set(msg.source, openTopic)
       store.linkMessage(openTopic.id, msg.messageId)
       lastTimestamp[msg.source] = msg.timestamp
```

**Prompt build flow (Task 5):**

```
budget = 60000 chars
recent_share = 0.5  → 30000 for verbatim
summary_share = 0.4 → 24000 for summaries
buffer = 0.1        → 6000 (consumed by 4A buildContextPrefix prefix)

verbatim: walk messages from newest backward, keep while sum(content) <= 30000
summaries: store.listFinalized(20) sorted importance DESC, finalized_at DESC
           prepend until block > 24000

return { messages: verbatim, summaryPrefix: block }
chat.ts appends summaryPrefix to system prompt, sends messages to Claude
```

## Post-Completion

**Manual verification:**
- After deploy, supervisor auto-restart picks up new code
- Existing chat_messages get bootstrapped into topics on the next message (first message after restart creates a new open topic; old messages remain unlinked — that's fine, they fall through to existing memory_vec recall via 4A)
- After 10 min idle, finalizer tick runs on whatever was closed
- Send a Discord message, observe `[topics] autoclosed N stale open topics` log on restart, and `[topicFinalizer] finalized topic <id>: <label>` log on tick

**No DB migration needed for existing data:**
- chat_messages stay as-is; topics get created prospectively
- Old (pre-deploy) chat_messages remain unlinked — that's the intentional bootstrapping behavior. They're still searchable via the existing memory_vec entry embeddings (4A indexes every chat turn already), so old context isn't lost — it just doesn't have a "topic" wrapper.

**External system updates:** none

**Backwards-compatibility:**
- `truncateMessages` stays exported as a fallback; tests using it pass as before
- If `setTopicDetector(null)` is left (e.g., in tests or alt configurations), `saveMessage` no-ops the topic side — existing chat flow unaffected
