# Decouple memory from router (LOCAL_LLM_MODE=disabled)

## Overview

Currently `LOCAL_LLM_MODE=disabled` sets `ollama = null` in `packages/server/src/index.ts`, and the memory service is gated on `memoryEnabled && ollama`. So disabling the local LLM for chat silently disables memory (embeddings + extractor) too.

Goal: split the Ollama client into two roles. `ollamaForRouter` is nulled when `LOCAL_LLM_MODE=disabled` (chat goes 100% to Claude). `ollamaForMemory` is created whenever `MEMORY_ENABLED=true`, independent of `LOCAL_LLM_MODE`, so embeddings + extractor keep working.

## Context

- `packages/server/src/index.ts:108-173` — current single `ollama` variable, loopback check, memory bootstrap
- `packages/server/src/ai/router.ts` — consumer of router ollama client
- `packages/server/src/memory/service.ts` — consumer of memory ollama client
- `packages/server/src/ai/__tests__/router.test.ts` — router tests (already covers `LOCAL_LLM_MODE=disabled`)

## Development Approach

- **Testing:** regular (code first, then tests)
- Small surgical change in `index.ts`, no API shape changes
- Preserve existing loopback PII guard — it must still fire whenever **either** path would send text to Ollama
- All tests must pass before completion

## Implementation Steps

### Task 1: Split ollama client into router + memory roles

- [x] in `packages/server/src/index.ts`, rename current `ollama` → `ollamaForRouter`; still nulled when `LOCAL_LLM_MODE=disabled`
- [x] add `ollamaForMemory`: created via `createOllamaClient()` whenever `MEMORY_ENABLED !== 'false'`, independent of `LOCAL_LLM_MODE`
- [x] if both `ollamaForRouter` and `ollamaForMemory` are null (i.e. `LOCAL_LLM_MODE=disabled` AND `MEMORY_ENABLED=false`), skip the loopback URL check and Ollama client creation entirely
- [x] otherwise run the existing loopback `OLLAMA_URL` PII guard (it protects both paths equally)
- [x] update memory bootstrap at `index.ts:154` to use `ollamaForMemory` instead of `ollama`
- [x] pass `ollamaForRouter` (not `ollama`) into router/tool-loop wiring
- [x] adjust startup logs: `[router] Local LLM disabled` when router client null, `[memory] enabled…` independent of router state
- [x] write tests: in `router.test.ts` (or a new `index.test.ts` if wiring is not directly unit-testable), add a case asserting that `LOCAL_LLM_MODE=disabled` + `MEMORY_ENABLED=true` produces a non-null memory service and a router path that does not invoke Ollama
- [x] write tests: error case — `LOCAL_LLM_MODE=disabled` + `MEMORY_ENABLED=false` skips Ollama entirely (no loopback check crash on invalid URL)
- [x] run `npm test` in `packages/server` — must pass before next task

### Task 2: Verify acceptance criteria

- [ ] manually confirm: with `LOCAL_LLM_MODE=disabled` + `MEMORY_ENABLED=true`, server boots, `[memory] enabled` logs, `[router] Local LLM disabled` logs
- [ ] grep for stray references to the old `ollama` identifier in `index.ts` — none remain
- [ ] run full `npm test` from repo root — all packages green
- [ ] run linter — clean

### Task 3: Update docs if needed

- [ ] if `README.md` or `AGENTS.md` documents `LOCAL_LLM_MODE`, update the description to clarify it gates only the chat router, not memory

## Technical Details

```ts
// Before
const ollama: OllamaClient | null = localLlmMode === 'disabled' ? null : createOllamaClient();
// ...
if (memoryEnabled && ollama) { memoryService = createMemoryService({ ollama, ... }); }

// After
const routerNeedsOllama = localLlmMode !== 'disabled';
const memoryNeedsOllama = memoryEnabled;
if (routerNeedsOllama || memoryNeedsOllama) {
  // existing loopback PII guard
}
const ollamaForRouter: OllamaClient | null = routerNeedsOllama ? createOllamaClient() : null;
const ollamaForMemory: OllamaClient | null = memoryNeedsOllama ? createOllamaClient() : null;
// ...
if (memoryEnabled && ollamaForMemory) { memoryService = createMemoryService({ ollama: ollamaForMemory, ... }); }
```

Two separate client instances are fine — `createOllamaClient()` is cheap and avoids any risk of shared state where one path disables the other.

## Post-Completion

- Merge `feature/decouple-memory-from-router` → `dev` → `master`
- Supervisor auto-restarts worker on master update
- User sets `LOCAL_LLM_MODE=disabled` in `.env` to force chat → Claude while memory keeps running
