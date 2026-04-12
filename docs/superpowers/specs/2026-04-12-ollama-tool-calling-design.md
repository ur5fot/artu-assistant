# Ollama Tool Calling

## Summary

Enable Ollama (local LLM) to execute tools natively via Ollama's tool calling API. Each tool gets a `provider` property that controls which AI engine can use it. Programming tools remain Claude-only; other tools default to Ollama when available.

## Provider Property

New field on `ToolDefinition`:

```typescript
provider: 'ollama' | 'claude' | 'all';
```

- `'ollama'` — only Ollama can use this tool
- `'claude'` — only Claude can use this tool
- `'all'` — Ollama by default, Claude as fallback if Ollama unavailable

Default value: `'claude'` (backward compatibility).

### Tool Assignments

| Tool | Provider |
|------|----------|
| `web_search` | `all` |
| `file_read` | `all` |
| `file_write` | `all` |
| `file_list` | `all` |
| `file_delete` | `all` |
| `file_move` | `all` |
| `code_task` | `claude` |

## Routing Logic

### When Ollama is available (`LOCAL_LLM_MODE=enabled`)

1. User message arrives at router
2. Router filters tools: `provider === 'ollama' || provider === 'all'`
3. Send message + filtered tools to Ollama via native tool calling API
4. If Ollama responds with `tool_calls` → run `ollama-tool-loop`:
   - Execute tool (with permissions, audit, events — same as Claude loop)
   - Feed result back to Ollama
   - Ollama generates human-readable response
   - Loop until no more tool_calls (max 10 iterations)
5. If Ollama responds with text only → escalation check as before:
   - Escalate → Claude gets tools where `provider === 'claude' || provider === 'all'`
   - No escalation → return Ollama response

### When Ollama is unavailable (`LOCAL_LLM_MODE=disabled`)

All messages go to Claude. Claude receives **all** tools regardless of `provider` value.

## File Changes

### New Files

#### `packages/server/src/ai/ollama-tool-loop.ts`

Tool execution loop for Ollama, analogous to `tool-loop.ts`:

- Input: messages, ollama client, filtered tools, emit callback, db, pendingConfirms
- Converts tools to Ollama format: `{ type: 'function', function: { name, description, parameters } }`
- Loop: send request → if tool_calls → execute → add result to messages → repeat
- Max 10 iterations
- Uses shared helpers for permissions, audit, events
- Returns `{ escalate: boolean }` — if Ollama emits escalation markers in text, signal router to hand off to Claude

#### `packages/server/src/ai/tool-helpers.ts`

Shared helper functions extracted from `tool-loop.ts`:

- `executeWithPermission(tool, input, ctx, emit, db, pendingConfirms)` — check permission level, request user confirmation if needed, execute handler
- `logAudit(db, toolName, input, result, duration)` — write to audit_log table
- `emitToolEvents(emit, action, data)` — emit SSE events (tool_call_start, tool_call_result, etc.)

### Modified Files

#### `packages/shared/src/types.ts`

Add `provider` field to `ToolDefinition`:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  provider: 'ollama' | 'claude' | 'all';  // NEW
  parameters: { type: 'object'; properties: {...}; required?: [...] };
  handler: (params, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input) => Promise<{ destructive: boolean; reason: string }>;
}
```

#### `packages/server/src/tools/registry.ts`

Add `getForProvider(provider: 'ollama' | 'claude')` method:

- `'ollama'` → returns tools where `provider === 'ollama' || provider === 'all'`
- `'claude'` → returns tools where `provider === 'claude' || provider === 'all'`

#### `packages/server/src/ai/ollama.ts`

- Accept optional `tools` parameter in `chat()` method
- Pass tools to Ollama API request in Ollama format
- Parse `tool_calls` from response (`message.tool_calls: [{ function: { name, arguments } }]`)
- Return type changes from `string` to `{ content: string; toolCalls?: OllamaToolCall[] }`

#### `packages/server/src/ai/tool-loop.ts`

Refactor to use shared helpers from `tool-helpers.ts`:

- Replace inline permission logic with `executeWithPermission()`
- Replace inline audit logging with `logAudit()`
- Keep Claude-specific message format handling

#### `packages/server/src/ai/router.ts`

- Filter tools by provider before passing to Ollama
- If Ollama response contains `tool_calls` → call `runOllamaToolLoop()`
- If text-only response → escalation check as before
- On escalation → pass Claude-filtered tools to `runToolLoop()`

#### `packages/server/src/ai/prompts.ts`

Update `getLocalSystemPrompt()`:

- Remove marker instructions for tool categories Ollama now handles natively (search, files)
- Keep escalation marker `[need tool: ...]` only for Claude-only tools (e.g., programming/code tasks)
- Add instruction: tools are available natively, use them when needed

#### Tool packages

Each tool sets its `provider`:

- `packages/tool-web-search/src/index.ts` — add `provider: 'all'`
- `packages/tool-files/src/index.ts` — add `provider: 'all'` to all file tools
- `packages/tool-code-task/src/index.ts` — add `provider: 'claude'`

## SSE Events

Ollama tool-loop emits the same events as Claude tool-loop — no frontend changes needed:

- `assistant_source: 'ollama'` (already exists)
- `tool_call_start`, `tool_call_result`, `tool_progress`
- `tool_confirm_request` (permissions work identically)
- `text_delta`, `done`

## Edge Cases

- **Ollama calls a tool but result triggers escalation:** Ollama processes the tool result normally. Escalation only happens on text responses with escalation markers.
- **Tool permission denied by user:** Same behavior as Claude loop — tool returns "denied" result, Ollama gets that and responds accordingly.
- **Ollama timeout during tool loop:** Abort signal propagates, partial response returned with error event.
- **Model doesn't support tool calling:** If Ollama model ignores tools and responds with text, normal escalation flow handles it (markers or empty response → Claude).
