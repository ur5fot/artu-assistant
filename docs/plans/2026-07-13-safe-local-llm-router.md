# Безопасный локальный маршрут для Qwen3 1.7B

## Outcome

R2 использует `qwen3:1.7b` только в задачах, которые помещаются в её реальную
способность и context window. Сложные, строгие и изменяющие состояние запросы
до локального inference уходят в Claude; локальные tool-вызовы ограничены
одним read-only доменом, а JSON-классификаторы используют schema-constrained
output с последующей проверкой кодом.

## Scope

- In scope: deterministic routing, local tool allowlist/phases, short modular
  prompt, local context budget, structured route logs, Ollama JSON Schema,
  focused router/context/tool/JSON tests.
- Non-goals: embeddings-based tool search, learned router, multi-agent runtime,
  local memory embeddings/extraction, mutating tools in Qwen.
- Source design: `docs/superpowers/specs/2026-07-13-safe-local-llm-router-design.md`.
- Source audit: `docs/2026-07-13-qwen3-1.7b-quality.md`.

## Context

- `packages/server/src/ai/router.ts` currently gives Qwen every Ollama tool and
  only escalates after an empty/help-seeking reply.
- `packages/server/src/ai/ollama-tool-loop.ts` re-offers all tools and asks the
  same model to verify its own answer.
- `packages/server/src/ai/prompts.ts` duplicates tool contracts in a large
  local prompt shared with unrelated domains.
- `packages/server/src/routes/chat.ts` compacts history with the Claude-sized
  `CHAT_CONTEXT_BUDGET_CHARS`; slash commands do not expose the requested tool
  name to the router.
- `packages/server/src/ai/ollama.ts` already has uncommitted runtime tuning
  (`num_ctx=8192`, `think=false` for Qwen3); implementation must preserve it.
- The worktree started with unrelated tutor changes. They remained untouched
  during router implementation, then were reconciled separately before the
  user-requested runtime restart.

## Approach

Keep routing and policy in pure TypeScript modules so decisions are cheap,
testable and independent of Qwen output. Treat Ollama tools as an explicit
allowlist rather than filtering by their broad provider metadata. Calculate
the local request budget after route/tool selection. Use Ollama `format` for
syntax/shape and existing TypeScript normalization for semantic correctness.

## Tasks

### Task 1: Route simple requests before local inference

**Files:**
- Create: `packages/server/src/ai/local-route.ts`
- Create: `packages/server/src/ai/__tests__/local-route.test.ts`
- Modify: `packages/server/src/ai/router.ts`
- Modify: `packages/server/src/routes/chat.ts`

- [x] Define the read-only domain allowlist and pure route decision contract.
- [x] Route action, code, math, strict-format, multi-domain and unsafe requests
  to Claude; keep simple chat and one read domain local.
- [x] Pass exact slash-command tool identity into the router.
- [x] Add table-driven tests covering local and Claude gates.
- [x] Run focused route tests.

### Task 2: Bound local prompt and context

**Files:**
- Create: `packages/server/src/ai/local-context.ts`
- Create: `packages/server/src/ai/__tests__/local-context.test.ts`
- Modify: `packages/server/src/ai/prompts.ts`
- Modify: `packages/server/src/ai/router.ts`
- Modify: `packages/server/src/ai/ollama.ts`

- [x] Replace the local prompt with a short common core plus selected domain
  policy without schema duplication.
- [x] Calculate budget from `OLLAMA_NUM_CTX`, output reserve, system prompt and
  selected tool schemas.
- [x] Add bounded memory/topic context and only whole recent messages; fall back
  before inference when the current request cannot fit.
- [x] Make Ollama `num_ctx` configurable while preserving Qwen3 `think=false`.
- [x] Add focused budget/trimming tests and run them.

### Task 3: Restrict and phase the local tool loop

**Files:**
- Modify: `packages/server/src/ai/ollama-tool-loop.ts`
- Modify: `packages/server/src/ai/router.ts`
- Modify: `packages/server/src/ai/__tests__/ollama-tool-loop.test.ts`
- Modify: `packages/server/src/ai/__tests__/router.test.ts`

- [x] Offer only the route-selected tool set and reject any unoffered call.
- [x] Narrow tools after search/list calls and remove all tools after terminal
  reads.
- [x] Remove same-model answer verification and cap the local loop.
- [x] Fall back to Claude on protocol/tool-loop failure without duplicating
  side effects.
- [x] Cover tool count, mutation exclusion, phase transitions and fallback in
  tests; run focused tests.

### Task 4: Constrain Ollama JSON outputs

**Files:**
- Modify: `packages/server/src/ai/ollama.ts`
- Modify: `packages/server/src/ai/__tests__/ollama.test.ts`
- Modify: `packages/server/src/emails/scorer.ts`
- Modify: `packages/server/src/emails/gist.ts`
- Modify: `packages/server/src/cognition/handlers/emailActionMatch.ts`
- Modify: relevant existing email/cognition tests

- [x] Add optional JSON Schema `format` to `OllamaClient.chat` and its request
  body.
- [x] Define narrow schemas for scorer, gist and action-match local calls.
- [x] Keep semantic coverage/range/known-id validation in TypeScript and Claude
  fallback for invalid results.
- [x] Test request shape and malformed/semantically incomplete fallback.
- [x] Run focused Ollama/email/cognition tests.

### Task 5: Expose privacy-safe route telemetry

**Files:**
- Create: `packages/server/src/ai/local-telemetry.ts`
- Modify: `packages/server/src/ai/router.ts`
- Modify: `packages/server/src/ai/__tests__/router.test.ts`

- [x] Log provider, reason, domain, tool names, estimated tokens, latency and
  fallback reason as one structured event.
- [x] Ensure logs exclude messages, prompts, arguments and tool results.
- [x] Cover local success, pre-route and runtime fallback events in tests.
- [x] Run focused router tests.

### Task 6: Verify acceptance criteria and document operation

**Files:**
- Modify: `README.md`
- Modify: `docs/worklog.md`
- Modify: `docs/plans/2026-07-13-safe-local-llm-router.md`

- [x] Verify every design acceptance criterion against implementation/tests.
- [x] Reconcile the pre-existing tutor changes: use `topicSteering`, preserve
  untouched-lesson mastery semantics and cover partial-stop progress.
- [x] Run `npm run build --workspace @r2/server`: clean.
- [x] Run `npm test --workspace @r2/server`: 2154/2154 passed across 141 files.
- [x] Restart the launchd supervisor and verify `/api/health` plus runtime route
  and structured-output smoke cases.
- [x] Document `OLLAMA_NUM_CTX`, route policy and structured route log fields.
- [x] Mark plan checkboxes accurately and add a worklog entry.

## Verification result

- Combined focused router/context/tool-loop/chat/structured-output suite:
  145 tests passed.
- Full server suite: 2154 tests passed across 141 files; server build passed.
- Real `qwen3:1.7b` scorer call returned complete schema-valid `5/2` results
  without Claude fallback.
- Runtime smoke with a fake read-only weather tool completed locally in about
  2.2 seconds: native tool call -> result with `tool_name` -> synthesis without
  tools. Simple chat stayed local; strict JSON and mutation routed to Claude
  before local inference.
- LaunchAgent restarted successfully; supervisor, worker, Ollama and
  `/api/health` were live after restart.
- `git diff --check` passed.

## Manual or external follow-up

After deployment, inspect route logs for at least several days and label false
local/false Claude routes. Only after a representative dataset exists should
we compare keyword routing with embedding tool search or a learned RouteLLM.
Run a separate model bake-off between `qwen3:1.7b` and `qwen3:4b` using the same
router eval set; do not expand permissions based on anecdotal chat quality.
