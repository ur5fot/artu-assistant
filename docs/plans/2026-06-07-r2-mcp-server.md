# R2 as an MCP server (local, in-process)

## Overview
Expose R2's tool arsenal to Claude Desktop / Claude Code as a local MCP server, so the
user can read R2 data and trigger R2 actions from the Claude clients they pay for via
their Claude subscription. R2 becomes a tool/data provider; the Claude client is the
brain (LLM orchestration runs on the subscription, R2 calls no LLM in this path).

Design spec: [docs/superpowers/specs/2026-06-07-r2-mcp-server-design.md](../superpowers/specs/2026-06-07-r2-mcp-server-design.md)

**Approach (locked in spec):** in-process MCP endpoint inside `@r2/server` (Express,
`127.0.0.1`), Streamable HTTP transport via `@modelcontextprotocol/sdk`, reusing the
**live** registry. Full arsenal (read+write) minus R2-internal tools. Plus a committed
stdio bridge for Claude Desktop. Local only, no network auth, PII raw in v1.

## Context (from discovery)
- **Express app** already on `127.0.0.1`; routers mounted `app.use(...)` before
  `errorHandler` ([index.ts:1268-1286](../../packages/server/src/index.ts)). `PORT` =
  `process.env.PORT || 3001` ([index.ts:104](../../packages/server/src/index.ts)).
- **Live registry**: `createRegistry()` ([index.ts:373](../../packages/server/src/index.ts)),
  populated by `await discoverTools(registry, deps)` ([index.ts:734](../../packages/server/src/index.ts)).
- **Single converter precedent**: `toClaudeTool()` ([base.ts:39](../../packages/server/src/tools/base.ts)) — `toMcpTool()` is the parallel.
- **Types**: `ToolDefinition` ([types.ts:75](../../packages/shared/src/types.ts)),
  `ToolResult` ([types.ts:34](../../packages/shared/src/types.ts)),
  `ToolContext` ([types.ts:44](../../packages/shared/src/types.ts)).
- **MCP SDK**: `@modelcontextprotocol/sdk` v1.29.0 already in `node_modules`
  (transitive) with `server/streamableHttp` — must add as a **direct** dep of `@r2/server`.
- **Internal tool names for denylist** (verified): `code_deploy`, `code_task`, `task`
  (tool-code-task exports two), `eval_add`, `eval_run`, plus tool-prompt-overlay names
  generated from `CONFIGS` (`cfg.toolName`, `permissionLevel:'confirm'` → not caught by
  the `forbidden` filter, MUST be in the name denylist — read exact strings in Task 4).
- **Test patterns**: `__tests__/*.test.ts` and co-located `*.test.ts` /
  `*.integration.test.ts` (e.g. [registry.test.ts](../../packages/server/src/tools/__tests__/registry.test.ts),
  [merge.test.ts](../../packages/server/src/routes/merge.test.ts)). Vitest.

## Development Approach
- **Testing approach: TDD** — write the failing test first, then implement until green.
- Complete each task fully before the next.
- **CRITICAL: every task includes new/updated tests** (success + error/edge cases) as
  separate checklist items.
- **CRITICAL: all tests pass before starting the next task.**
- **CRITICAL: update this plan when scope changes during implementation.**
- Small focused changes; reuse existing patterns (`toClaudeTool`, router factories).
- Backward compatible: MCP is off unless `MCP_ENABLED=true` — zero impact on existing R2.

## Testing Strategy
- **Unit**: `toMcpTool` conversion + annotations; `ToolResult→CallToolResult` mapping;
  headless `ToolContext`; denylist/`forbidden` filtering; env-config parsing.
- **Integration**: drive the MCP server over the SDK's `InMemoryTransport` against a
  registry seeded with real tools on a temp DB — `list_tools` returns the exposed set
  and excludes internal ones; call a read tool (mocked) and a write tool
  (`reminder_create`); assert mapping and `isError` on unknown tool.
- No project e2e/UI suite involved; client wiring is verified manually (Post-Completion).

## Progress Tracking
- Mark `[x]` immediately when done. New tasks ➕, blockers ⚠️. Keep in sync with work.

## What Goes Where
- **Implementation Steps** (`[ ]`): code, tests, docs in this repo.
- **Post-Completion** (no checkboxes): manual client wiring + deploy via the user's
  ralphex flow.

## Implementation Steps

### Task 1: Dependency + env config (MCP_ENABLED, MCP_TOOL_DENYLIST)
- [x] add `@modelcontextprotocol/sdk` (^1.29.0) to `packages/server/package.json` deps
- [x] add `MCP_ENABLED`, `MCP_TOOL_DENYLIST` to `.env.example` with comments
- [x] extend the server env-config module to parse `MCP_ENABLED` (default `false`) and
      `MCP_TOOL_DENYLIST` (comma-separated → string[]) — `envBool`/`envCsv` in `env-utils.ts`
- [x] write tests: `MCP_ENABLED` default off + truthy parsing; denylist parse (empty,
      single, multi, whitespace trimming)
- [x] run tests — must pass before next task

### Task 2: `toMcpTool` converter
- [x] write failing tests `packages/server/src/mcp/__tests__/to-mcp-tool.test.ts`:
      name/description pass-through; `inputSchema` built from `parameters`
      (`type/properties/required`); `destructiveHint:true` for `permissionLevel:'confirm'`
      or a tool with `preCheck`; `readOnlyHint` omitted
- [x] implement `packages/server/src/mcp/to-mcp-tool.ts` (parallel to `toClaudeTool`)
- [x] add edge tests: tool with no `required`; tool with `preCheck` but `auto` level
- [x] run tests — must pass before next task

### Task 3: Result mapper + headless `ToolContext`
- [x] write failing tests `packages/server/src/mcp/__tests__/runtime.test.ts`:
      `ToolResult.success` → content (prefer `display.content`, else JSON `data`);
      `success:false` → `isError:true` with `error`; handler throw → `isError:true`;
      headless ctx: `requestPlanReview`/`requestMemoryConfirm` resolve approved,
      `onProgress` is a no-op
- [x] implement `packages/server/src/mcp/runtime.ts`: `toCallToolResult(result)` +
      `makeHeadlessCtx({ signal, callId })`
- [x] run tests — must pass before next task

### Task 4: Tool filtering (denylist + forbidden)
- [x] read exact prompt-overlay tool names from `tool-prompt-overlay` `CONFIGS` and
      record the full internal denylist constant: `code_deploy`, `code_task`, `task`,
      `eval_add`, `eval_run`, `prompt_overlay_claude`, `prompt_overlay_ollama`
      (verified `eval_add`/`eval_run` live in `tool-eval-add`/`tool-eval-run`; no live
      tool literally named `task` — kept as harmless defense-in-depth per plan)
- [x] write failing tests: filter excludes internal names + any `permissionLevel:'forbidden'`;
      exposes non-internal tools; `MCP_TOOL_DENYLIST` extends the default; unknown
      denylist entries are ignored
- [x] implement `selectMcpTools(registry, denylist)` (returns the exposed `ToolDefinition[]`)
- [x] run tests — must pass before next task

### Task 5: MCP server + Streamable HTTP Express route
- [x] write failing integration test `packages/server/src/mcp/__tests__/server.integration.test.ts`
      driving the server via `InMemoryTransport`: `list_tools` = exposed set & excludes
      internal; call a mocked read tool; call `reminder_create` against a temp DB; assert
      `CallToolResult` mapping; unknown tool → error
- [x] implement `packages/server/src/mcp/server.ts`: `createMcpServer`/`createMcpRouter({ registry, denylist })`
      → low-level `Server` (raw JSON-Schema tools; `McpServer.registerTool` wants Zod)
      listing `selectMcpTools` via `toMcpTool`; `CallTool` handler re-checks exposure, runs
      `tool.handler(params, headlessCtx)` and maps via `toCallToolResult`, wired to
      `StreamableHTTPServerTransport` as a stateless Express handler
- [x] add error tests: denylisted/unknown tool call → `isError`; thrown handler → `isError`
- [x] run tests — must pass before next task

### Task 6: Wire into `index.ts` behind `MCP_ENABLED`
- [ ] mount `app.use('/mcp', createMcpRouter({ registry, denylist }))` after
      `discoverTools` populates the registry and before `errorHandler`, only when
      `MCP_ENABLED`
- [ ] write test (cognition-wiring style): route present when enabled, absent when disabled
- [ ] run tests — must pass before next task

### Task 7: stdio bridge + client wiring docs
- [ ] add `scripts/r2-mcp-stdio.sh` → `exec npx -y mcp-remote "http://127.0.0.1:${PORT:-3001}/mcp"` (executable)
- [ ] add README section: Claude Code (`claude mcp add --transport http r2 http://127.0.0.1:3001/mcp`)
      and Claude Desktop (config pointing at the bridge script)
- [ ] shellcheck the script if available; otherwise note manual verification
- [ ] run tests — must pass before next task

### Task 8: Verify acceptance criteria
- [ ] verify every spec requirement is implemented (scope, local bind, denylist,
      permission→`destructiveHint`, headless ctx, result mapping, PII raw, MCP_ENABLED gate)
- [ ] run full unit + integration suite
- [ ] run linter — fix all issues
- [ ] verify coverage meets project standard (80%+)

### Task 9: [Final] Documentation
- [ ] finalize README MCP section and `.env.example`
- [ ] note the new `packages/server/src/mcp/` module in project knowledge/AGENTS.md if patterns warrant

*Note: ralphex automatically moves completed plans to `docs/plans/completed/`.*

## Technical Details
- **Denylist** keyed on tool name (provenance isn't tracked on `ToolDefinition`).
  Default = internal names above; `MCP_TOOL_DENYLIST` extends it; `forbidden` always out.
- **Headless ctx** rationale: the MCP client prompts the user before each tool call, so
  R2's Discord-based confirm callbacks auto-approve; destructiveness surfaced via
  `destructiveHint`.
- **Result mapping**: `display.content` preferred for human-readable rendering; else
  JSON-stringified `data`; failures → `isError`.
- **Transport**: `StreamableHTTPServerTransport` (POST `/mcp`, GET for SSE stream).
  Tests use `InMemoryTransport` to avoid binding a port.

## Post-Completion
*Manual / external — no checkboxes.*

**Manual verification:**
- Set `MCP_ENABLED=true`, restart the R2 service (`npm run service:restart`).
- Claude Code: `claude mcp add --transport http r2 http://127.0.0.1:3001/mcp`, then
  confirm tools list and a read call (e.g. weather) + a write call (e.g. reminder_create).
- Claude Desktop: add the bridge script to its MCP config; confirm the same.

**Deploy** (user's flow): sync `dev`←`master`, run ralphex, then `dev`→`master` +
`git push origin master` (supervisor polls `origin/master`, auto-restart).
