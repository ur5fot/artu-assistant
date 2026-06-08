# R2 as an MCP server — design

**Date:** 2026-06-07
**Status:** Approved (design), pending implementation plan

## Goal

Expose R2's tool arsenal to Claude Desktop / Claude Code as an MCP server, so the
user can read R2's data and trigger R2 actions from the Claude clients they already
pay for via their Claude subscription (Max/Pro) — instead of only through R2's own
Discord/API-key chat path.

One sentence: **R2 becomes a tool/data provider; the Claude client is the brain.**

## Why this uses the subscription (and what it does not)

- The **LLM orchestration** (deciding what to do, reading tool results, talking to
  the user) runs inside Claude Desktop/Code → **on the Claude subscription**. ✅
- In the MCP path **R2 calls no LLM** — it just runs tool handlers (DB queries,
  reminders, web search…) and returns data. **Zero tokens, R2's `ANTHROPIC_API_KEY`
  is not touched.**
- **Not in scope:** moving R2's own autonomous brain (observer loop, morning brief,
  distraction judge, Discord replies) onto the subscription. That brain keeps running
  on `ANTHROPIC_API_KEY` (pay-per-token), unchanged. (That would be a separate effort:
  rewriting the brain onto the Agent SDK — "variant B".)
- **Caveat:** a few tools call an LLM internally (e.g. `memory` extraction via
  `MEMORY_EXTRACT_MODEL_CLAUDE`). When such a tool is invoked over MCP, that internal
  call still bills to R2's API key, not the subscription. Most exposed tools (reminder,
  weather, files, web-search, web-fetch, activity) are pure data ops with no LLM cost.

## Decisions (locked)

| Question | Decision |
|---|---|
| Scope | Full arsenal — read + write, all registry tools except R2-internal ones |
| Reach | Local only — Claude Desktop/Code on the same Mac as R2; bind `127.0.0.1` |
| Runtime/transport | **C** — in-process MCP over localhost HTTP **+** a committed stdio bridge for Claude Desktop |
| Network auth | None for v1 (localhost-restricted) |
| PII | v1 returns raw data (own data, own subscription) |

## Architecture & data flow

```
Claude Desktop / Claude Code  (the LLM, on the subscription)
   │  stdio bridge (mcp-remote)   OR   direct HTTP
   ▼
POST /mcp   on the existing R2 Express app (127.0.0.1:PORT)   ← same process as R2's brain
   ▼
MCP server (@modelcontextprotocol/sdk, Streamable HTTP transport)
   ▼
live registry.get(name).handler(params, headlessCtx)
   ▼
ToolResult → MCP CallToolResult → client
```

Two consumers of one live tool registry:
- existing Claude chat loop via `toClaudeTool()` ([base.ts:39](../../../packages/server/src/tools/base.ts))
- new MCP path via `toMcpTool()`

Reusing the **live** registry instance (`createRegistry()` at
[index.ts:373](../../../packages/server/src/index.ts)) means MCP shares R2's single
DB handle, deps, PII proxy, and side-effect channels — so write/action tools work with
no duplicated wiring and no cold-process SQLite contention.

## Components (new code)

- **`packages/server/src/mcp/to-mcp-tool.ts`** — converts a `ToolDefinition`
  ([types.ts:75](../../../packages/shared/src/types.ts)) → MCP tool registration:
  - `name`, `description` pass through
  - `inputSchema` from `parameters` (`{type:'object', properties, required}`)
  - MCP annotations: `destructiveHint: true` for `permissionLevel:'confirm'` or a
    `preCheck` destructive path. `readOnlyHint` is **not** reliably derivable from
    current `ToolDefinition` metadata (a tool can be `auto` yet have side effects), so
    v1 omits it rather than risk mislabeling — add later if a read-only flag is
    introduced
- **`packages/server/src/mcp/server.ts`** — builds the MCP server, wires the
  Streamable HTTP transport as an Express handler, filters tools (see below),
  constructs the headless `ToolContext`, and maps `ToolResult` → `CallToolResult`.
- **`packages/server/src/index.ts`** — mount the route (e.g. `POST /mcp`), pass the
  live `registry`, gate behind `MCP_ENABLED`.
- **`scripts/r2-mcp-stdio.sh`** — `npx mcp-remote http://127.0.0.1:PORT/mcp` for a
  clean stdio config in Claude Desktop.
- **`.env.example`** — add `MCP_ENABLED`, optional `MCP_TOOL_DENYLIST`.
- **dependency** — `@modelcontextprotocol/sdk` in `@r2/server`.

## Tool selection

**Exposed:** `memory`, `reminder`, `weather`, `files`, `web-search`, `web-fetch`,
`activity`, `emails` *(emails respects the existing email feature flag — when that
flag is off, its tools are absent from the registry and therefore from MCP too)*.

**Excluded (R2-internal / self-management / dev):** `code-deploy` *(deploys R2
itself)*, `code-task`, `eval-add`, `eval-run`, `prompt-overlay`.

**Mechanism:** a default denylist keyed on **tool name** (the exact names the internal
packages above contribute — `code-deploy`, `code-task`, `eval-add`, `eval-run`,
`prompt-overlay` — enumerated precisely during planning), plus
`permissionLevel:'forbidden'` always excluded. Override via `MCP_TOOL_DENYLIST`
(comma-separated) env var. Denylist (not allowlist) is the default so newly added
non-internal tools are exposed automatically; new internal tools must be added to the
denylist when introduced.

## Permission / confirm handling

R2's interactive confirm flow (`requestPlanReview` / `requestMemoryConfirm` over
Discord) has no place over MCP — **the MCP client itself prompts the user for approval
before every tool call**, which is the human gate.

- `forbidden` → not exposed.
- `confirm` / `preCheck` destructive → exposed, flagged `destructiveHint: true` so the
  client shows a warning.
- **Headless `ToolContext`** for MCP calls:
  - `requestPlanReview` → resolves `{approved: true}` (client already gated the call)
  - `requestMemoryConfirm` → resolves approved
  - `onProgress` → no-op in v1 (could become MCP progress notifications later)
  - `signal` → from the HTTP request
  - `meta` → `{ callId }`

## Result mapping

`ToolResult` ([types.ts:34](../../../packages/shared/src/types.ts)) → MCP `CallToolResult`:
- `success: true` → content block(s): prefer `display.content` when present
  (text/table/link/code/file), else JSON-stringified `data`.
- `success: false` → `isError: true` with `error` text.
- handler throws → caught → `isError: true` with the error message.

## Security & PII

- Bind `127.0.0.1` only (already how the Express server binds); no network auth in v1.
- DNS-rebinding guard: the `/mcp` router rejects any request whose `Host` (or, when
  present, `Origin`) header does not resolve to loopback. Binding to `127.0.0.1` alone
  does not stop a malicious page from rebinding a hostname it controls to `127.0.0.1`
  and POSTing to this unauthenticated, tool-executing endpoint; the SDK transport
  (v1.29.0) has no built-in Host/Origin validation, so the router enforces it.
- Denylist keeps R2 self-management (`code-deploy`/`code-task`) out of reach.
- PII: v1 returns raw tool results. Anonymizing via the Presidio proxy would strip the
  data the user actually wants. Optional future flag: route MCP results through the PII
  proxy.

## Error handling

- Unknown tool name → MCP error.
- Tool present but denylisted → not listed; a direct call is rejected as unknown.
- Handler `success:false` or thrown error → `CallToolResult` with `isError: true`.

## Testing

- **Unit:** `toMcpTool` conversion (schema + annotations); result mapping
  (success/display/error/throw); denylist + `forbidden` filtering; headless-ctx
  auto-approve behavior.
- **Integration:** boot the MCP route against a temp DB; `list_tools` returns the
  expected exposed set and excludes internal ones; call a read tool (mocked
  web-search/weather) and a write tool (`reminder_create`) and assert the
  `ToolResult` → `CallToolResult` mapping.
- Follow existing vitest patterns in `packages/server`.

## Client wiring (docs to add to README)

- **Claude Code:** `claude mcp add --transport http r2 http://127.0.0.1:PORT/mcp`
- **Claude Desktop:** point its MCP config at `scripts/r2-mcp-stdio.sh` (stdio bridge),
  or use a native remote connector to the same URL.

## Out of scope (future)

- Variant B — moving R2's autonomous brain onto the Agent SDK / subscription.
- Remote reach over tailnet (would add HTTP over the tailnet cert + a bearer token).
- Optional PII anonymization of MCP results.
- MCP progress notifications wired to `onProgress`.
