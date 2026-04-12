# Phase 3F: Chat Commands + UI

## Summary

Three UI features to complete Phase 3: command palette for quick tool access, status bar with session info, and colored unified diff view for code_task results.

## 1. Command Palette + Chat Commands

### Server: Commands Endpoint

New `GET /api/commands` endpoint. Returns tool-derived command list from the registry.

Response format:
```json
[
  {
    "name": "task",
    "tool": "code_task",
    "description": "Run a code task",
    "params": [{ "name": "task", "required": true, "description": "Task description" }]
  },
  {
    "name": "deploy",
    "tool": "code_deploy",
    "description": "Deploy changes to production",
    "params": []
  }
]
```

New optional field on `ToolDefinition`:

```typescript
command?: {
  name: string;           // slash command name (e.g. "task")
  description: string;    // shown in palette
  params?: Array<{
    name: string;
    required: boolean;
    description?: string;
  }>;
};
```

Tools without `command` are invisible in the palette but still available to LLMs. The `/api/commands` endpoint reads `command` from each registered tool.

### Server: Command Dispatch

When a user message starts with `/`, the chat route intercepts it before sending to the LLM:

1. Parse command name and arguments from the message text (e.g. `/search weather Odesa` → command: "search", args: "weather Odesa")
2. Look up command in registry by name
3. Map args to tool parameters (positional: first required param gets the rest of the string)
4. Call the tool directly via tool-loop (so permissions, audit, PII all work as normal)
5. LLM receives the tool result and formulates a human response

If command is not found → send as normal message to LLM (so `/something` that isn't a command just goes to the AI).

### Client: Command Palette

Triggered by:
- **Cmd+K** (Mac) / **Ctrl+K** (Win/Linux) keyboard shortcut
- Typing `/` as the first character in ChatInput

UI behavior:
- Modal overlay centered on screen, dark backdrop
- Search input at top, auto-focused
- List of commands below, filtered as user types
- Each item shows: command name, description
- Arrow keys to navigate, Enter to select, Escape to close
- Selecting a command:
  - If no required params → execute immediately (insert `/command` in chat and send)
  - If has required params → insert `/command ` in ChatInput with cursor at end, close palette

Data source: fetched from `/api/commands` on mount, cached in state.

## 2. Status Bar

### Location

Compact bar below ChatInput (bottom of the chat window).

### Content

Three pieces of information, left to right:

- **LLM indicator** — which model answered last: "Ollama (qwen2.5:7b)" or "Claude". Source comes from `assistant_source` SSE event already tracked in useChat.
- **Message count** — total messages in current session: `messages.length`
- **Response time** — time of last response: measured as delta between send() call and `done` SSE event. Displayed as "N.Ns" (e.g. "1.2s").

### Implementation

Purely client-side — no new endpoint needed:

- New `StatusBar` component rendered below ChatInput in Chat.tsx
- `useChat` hook tracks `lastResponseTime` (new state): set timestamp on send(), compute delta on `done` event
- `useChat` already tracks `messages` and last `assistant_source`
- Styling: 11px font, #888 color, flex row with space-between, thin top border, matching theme variables

The existing worker crash/restart status bar (in App.tsx) remains separate — it's an overlay that appears on crash, not a persistent bar.

## 3. Diff View

### Replace current raw diff block

Currently in ToolCallCard, code_task results show a raw text diff in a dark monospace block. Replace with colored unified diff using `diff2html` library.

### Features

- Green background for added lines, red for removed
- Line numbers on the left
- File name header with +N / -N stats per file
- Expand/collapse toggle stays as-is ("Show diff" / "Hide diff")
- Only unified output style (no side-by-side)
- Dark theme matching existing code blocks (#1e293b background)

### Implementation

- Add `diff2html` package to client
- New `DiffView` component in `packages/client/src/components/DiffView.tsx`
- Takes unified diff string as prop, renders via `Diff2Html.html()` with `outputFormat: 'line-by-line'`
- Override diff2html default CSS to match R2 dark theme
- ToolCallCard replaces the existing `<pre>` diff block with `<DiffView diff={fullDiff || shortDiff} />`

## File Changes Summary

### New Files
- `packages/server/src/routes/commands.ts` — GET /api/commands endpoint
- `packages/client/src/components/CommandPalette.tsx` — modal command palette
- `packages/client/src/components/DiffView.tsx` — colored unified diff
- `packages/client/src/components/StatusBar.tsx` — bottom status bar

### Modified Files
- `packages/shared/src/types.ts` — add optional `command` to ToolDefinition
- `packages/server/src/index.ts` — register commands route
- `packages/server/src/routes/chat.ts` — intercept `/command` messages
- `packages/server/src/tools/registry.ts` — add `getCommands()` method
- `packages/client/src/components/Chat.tsx` — add StatusBar, integrate CommandPalette
- `packages/client/src/components/ChatInput.tsx` — detect `/` for palette trigger, Cmd+K handler
- `packages/client/src/components/ToolCallCard.tsx` — replace raw diff with DiffView
- `packages/client/src/hooks/useChat.ts` — track lastResponseTime
- `packages/client/src/theme.css` — diff2html theme overrides
- Tool packages (tool-web-search, tool-files, tool-code-task, tool-code-deploy, tool-eval-add, tool-eval-run) — add `command` field

## Edge Cases

- **Unknown command:** `/foo bar` where "foo" is not a registered command → send as normal message to LLM
- **Empty command:** just `/` → open palette, don't send
- **Command with no args when args required:** `/task` with no description → LLM asks for clarification
- **Palette during loading:** disable palette while response is streaming
- **Diff with binary files:** diff2html handles binary file markers gracefully
- **No messages yet:** status bar shows "Ollama" (default) + "0 messages" + no response time
