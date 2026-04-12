# Ollama Tool Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Ollama to call tools natively, with a `provider` field on each tool controlling which AI engine can use it.

**Architecture:** Add `provider` to ToolDefinition, create shared tool-execution helpers (extracted from tool-loop.ts), build an Ollama-specific tool-loop, and update the router to pass filtered tools to Ollama and handle its tool_calls responses.

**Tech Stack:** TypeScript, Ollama REST API (native tool calling), existing Express/SSE infrastructure.

---

### Task 1: Add `provider` field to ToolDefinition

**Files:**
- Modify: `packages/shared/src/types.ts:42-53`

- [x] **Step 1: Add provider to ToolDefinition interface**

In `packages/shared/src/types.ts`, add the `provider` field to `ToolDefinition`:

```typescript
export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  provider: 'ollama' | 'claude' | 'all';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>, ctx?: ToolContext) => Promise<ToolResult>;
  preCheck?: (input: Record<string, unknown>) => Promise<{ destructive: boolean; reason: string }>;
}
```

- [x] **Step 2: Build to verify types compile**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/shared`
Expected: Compilation errors in tool packages that don't have `provider` yet — that's fine, we fix them in the next task.

- [x] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add provider field to ToolDefinition"
```

---

### Task 2: Set `provider` on all tool packages

**Files:**
- Modify: `packages/tool-web-search/src/index.ts:17`
- Modify: `packages/tool-files/src/index.ts:5-104`
- Modify: `packages/tool-code-task/src/index.ts` (find the ToolDefinition object)

- [x] **Step 1: Add `provider: 'all'` to web_search tool**

In `packages/tool-web-search/src/index.ts`, add `provider` after `permissionLevel`:

```typescript
export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using SearXNG. Use when you need current information, facts, or answers not in your training data.',
  permissionLevel: 'auto' as const,
  provider: 'all' as const,
  // ... rest unchanged
```

- [x] **Step 2: Add `provider: 'all'` to all file tools**

In `packages/tool-files/src/index.ts`, add `provider: 'all' as const` after `permissionLevel` on each of the 5 tool objects (`file_read`, `file_write`, `file_list`, `file_delete`, `file_move`).

Example for `file_read`:
```typescript
  {
    name: 'file_read',
    description: 'Read the contents of a text file...',
    permissionLevel: 'auto' as const,
    provider: 'all' as const,
    // ... rest unchanged
```

Repeat for all 5 tools.

- [x] **Step 3: Add `provider: 'claude'` to code_task tool**

In `packages/tool-code-task/src/index.ts`, find the tool definition object and add:

```typescript
provider: 'claude' as const,
```

after `permissionLevel`.

- [x] **Step 4: Build all packages to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS — all packages compile.

- [x] **Step 5: Commit**

```bash
git add packages/tool-web-search/src/index.ts packages/tool-files/src/index.ts packages/tool-code-task/src/index.ts
git commit -m "feat: set provider on all tool packages"
```

---

### Task 3: Add `getForProvider()` to registry

**Files:**
- Modify: `packages/server/src/tools/registry.ts:7-31`

- [x] **Step 1: Add getForProvider method to ToolRegistry interface and implementation**

In `packages/server/src/tools/registry.ts`, update the interface and implementation:

```typescript
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getForProvider(provider: 'ollama' | 'claude'): ToolDefinition[];
}
```

In `createRegistry()`, add the method:

```typescript
    getForProvider(provider: 'ollama' | 'claude'): ToolDefinition[] {
      return [...tools.values()].filter(
        (t) => t.provider === provider || t.provider === 'all',
      );
    },
```

- [x] **Step 2: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/server/src/tools/registry.ts
git commit -m "feat: add getForProvider filter to tool registry"
```

---

### Task 4: Extract shared helpers from tool-loop.ts

**Files:**
- Create: `packages/server/src/ai/tool-helpers.ts`
- Modify: `packages/server/src/ai/tool-loop.ts:37-103,196-349`

- [x] **Step 1: Create tool-helpers.ts with shared functions**

Create `packages/server/src/ai/tool-helpers.ts`:

```typescript
import type { SSEEvent, ToolCall, ToolResult, ToolContext, ToolDefinition, PlanReviewResponse } from '@r2/shared';
import type { ConfirmResponse, PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';

export async function deanonDeep(value: unknown, piiProxy: PiiProxy): Promise<unknown> {
  if (typeof value === 'string') return piiProxy.deanonymize(value);
  if (Array.isArray(value)) return Promise.all(value.map(v => deanonDeep(v, piiProxy)));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = await deanonDeep(v, piiProxy);
    }
    return result;
  }
  return value;
}

export function requestConfirmation(
  callId: string,
  toolCall: ToolCall,
  level: 'confirm' | 'forbidden',
  onEvent: (event: SSEEvent) => void,
  pendingConfirms: PendingConfirms,
  signal?: AbortSignal,
  destructiveWarning?: { reason: string },
): Promise<ConfirmResponse> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ allowed: false, remember: false });
      return;
    }
    const onAbort = () => {
      pendingConfirms.delete(callId);
      resolve({ allowed: false, remember: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingConfirms.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_confirm_request', toolCall, level, destructiveWarning });
  });
}

export function createPlanReviewRequester(
  callId: string,
  task: string,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): (plan: string) => Promise<PlanReviewResponse> {
  return (plan: string) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ approved: false });
      return;
    }
    const onAbort = () => {
      pendingPlanReviews.delete(callId);
      resolve({ approved: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingPlanReviews.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_plan_review', id: callId, task, plan });
  });
}

export function buildToolContext(
  blockId: string,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: blockId, message }),
    requestPlanReview: createPlanReviewRequester(blockId, task, onEvent, pendingPlanReviews, signal),
    signal,
    meta: { autoMode, callId: blockId },
  };
}

/**
 * Execute a tool with permission checks, audit logging, and PII handling.
 * Returns the tool result (for Claude message history) and a client-facing result
 * (which may include heavy fields like fullDiff stripped from the Claude-facing one).
 */
export async function executeToolWithPermission(params: {
  toolDef: ToolDefinition;
  blockId: string;
  input: Record<string, unknown>;
  onEvent: (event: SSEEvent) => void;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  signal?: AbortSignal;
}): Promise<{ result: ToolResult; clientResult: ToolResult }> {
  const { toolDef, blockId, input, onEvent, pendingConfirms, pendingPlanReviews, piiProxy, signal } = params;

  const toolCall: ToolCall = {
    id: blockId,
    name: toolDef.name,
    input,
    status: 'running',
  };
  onEvent({ type: 'tool_call_start', toolCall });

  let result: ToolResult;
  const startTime = Date.now();

  if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
    let allowed: boolean | null = null;
    let autoMode = false;
    let destructiveWarning: { reason: string } | undefined;

    if (toolDef.preCheck) {
      try {
        const check = await toolDef.preCheck(input);
        if (check.destructive) {
          destructiveWarning = { reason: check.reason };
          allowed = null;
        }
      } catch (err) {
        console.error('preCheck failed:', err instanceof Error ? err.message : err);
        destructiveWarning = { reason: 'precheck failed — review manually' };
        allowed = null;
      }
    }

    if (allowed === null && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
      try {
        const rule = getPermissionRule(toolDef.name);
        if (rule) {
          allowed = rule.allowed;
          if (rule.allowed) autoMode = true;
        }
      } catch (err) {
        console.error('Failed to read permission rule:', err instanceof Error ? err.message : err);
      }
    }

    if (allowed === null) {
      const confirmResponse = await requestConfirmation(
        blockId, toolCall, toolDef.permissionLevel, onEvent, pendingConfirms, signal, destructiveWarning,
      );
      allowed = confirmResponse.allowed;

      if (confirmResponse.remember && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
        try {
          savePermissionRule(toolDef.name, confirmResponse.allowed);
          if (confirmResponse.allowed) autoMode = true;
        } catch (err) {
          console.error('Failed to save permission rule:', err instanceof Error ? err.message : err);
        }
      }
    }

    if (allowed) {
      try {
        const task = typeof input.task === 'string' ? input.task : '';
        const ctx = buildToolContext(blockId, task, autoMode, onEvent, pendingPlanReviews, signal);
        result = await toolDef.handler(input, ctx);
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    } else {
      result = { success: false, error: 'Action denied by user' };
    }
  } else {
    // permissionLevel === 'auto'
    try {
      const task = typeof input.task === 'string' ? input.task : '';
      const ctx = buildToolContext(blockId, task, false, onEvent, pendingPlanReviews, signal);
      result = await toolDef.handler(input, ctx);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  const durationMs = Date.now() - startTime;

  // Split heavy presentational fields (fullDiff) before PII anonymization
  let fullDiffSideChannel: unknown = undefined;
  if (result.success && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
    const data = result.data as Record<string, unknown>;
    if ('fullDiff' in data) {
      fullDiffSideChannel = data.fullDiff;
      const { fullDiff: _fd, ...rest } = data;
      result = { ...result, data: rest };
    }
  }

  // Anonymize tool result before logging and sending back to LLM
  if (result.data) {
    const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
    if (anonResult.entities.length > 0) {
      try {
        result = { ...result, data: JSON.parse(anonResult.text) };
      } catch {
        result = { ...result, data: anonResult.text };
      }
    }
  }

  // Audit log
  try {
    logToolCall({ toolName: toolDef.name, input, result, success: result.success, durationMs });
  } catch (err) {
    console.error('Audit log write failed:', err instanceof Error ? err.message : err);
  }

  // Re-attach fullDiff for the client event
  const clientResult =
    fullDiffSideChannel !== undefined && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? { ...result, data: { ...(result.data as Record<string, unknown>), fullDiff: fullDiffSideChannel } }
      : result;

  onEvent({ type: 'tool_call_result', id: blockId, result: clientResult });

  return { result, clientResult };
}
```

- [x] **Step 2: Refactor tool-loop.ts to use shared helpers**

In `packages/server/src/ai/tool-loop.ts`:

1. Remove the local `requestConfirmation`, `createPlanReviewRequester`, `buildToolContext` functions (lines 37-103) and the `deanonDeep` function (lines 13-24).
2. Import them from tool-helpers:

```typescript
import { requestConfirmation, buildToolContext, executeToolWithPermission, deanonDeep } from './tool-helpers.js';
```

3. Replace the entire tool execution block (lines 183-349, the `for (const block of toolUseBlocks)` loop body) with a call to `executeToolWithPermission`:

```typescript
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      if (signal?.aborted) return;

      const deanonInput = await deanonDeep(block.input, piiProxy) as Record<string, unknown>;

      const toolDef = registry.get(block.name);
      if (!toolDef) {
        const toolCall: ToolCall = { id: block.id, name: block.name, input: deanonInput, status: 'running' };
        onEvent({ type: 'tool_call_start', toolCall });
        const result: ToolResult = { success: false, error: `Unknown tool: ${block.name}` };
        onEvent({ type: 'tool_call_result', id: block.id, result });
        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result.error),
          is_error: true,
        });
        continue;
      }

      const { result } = await executeToolWithPermission({
        toolDef,
        blockId: block.id,
        input: deanonInput,
        onEvent,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        signal,
      });

      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.success ? (result.data ?? '') : (result.error ?? 'Unknown error')),
        ...(result.success ? {} : { is_error: true }),
      });
    }
```

4. Remove now-unused imports: `logToolCall`, `getPermissionRule`, `savePermissionRule` from `../db.js`. Remove `ConfirmResponse`, `PendingConfirms` type usage if no longer needed locally (they're still needed for the `pendingConfirms` param). Remove `createPlanReviewRequester` import from local scope. Keep `PendingPlanReviews` import since it's in ToolLoopParams.

- [x] **Step 3: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 4: Commit**

```bash
git add packages/server/src/ai/tool-helpers.ts packages/server/src/ai/tool-loop.ts
git commit -m "refactor: extract shared tool-execution helpers from tool-loop"
```

---

### Task 5: Update Ollama client for tool calling

**Files:**
- Modify: `packages/server/src/ai/ollama.ts`

- [x] **Step 1: Add tool types and update chat interface**

In `packages/server/src/ai/ollama.ts`, update the interfaces:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OllamaChatParams {
  messages: MessageParam[];
  system?: string;
  signal?: AbortSignal;
  tools?: OllamaToolDef[];
}

interface OllamaChatResult {
  text: string;
  toolCalls?: OllamaToolCall[];
}

export interface OllamaClient {
  chat(params: OllamaChatParams): Promise<OllamaChatResult>;
}
```

- [x] **Step 2: Update toOllamaMessage to handle tool-result messages**

Add support for tool role messages in the conversion. After the existing `toOllamaMessage` function, the `chat()` method needs to handle tool results. Update `toOllamaMessage` to also accept tool-result messages:

```typescript
interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

function toOllamaMessage(msg: MessageParam): OllamaMessage {
  let content: string;
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    const hasNonText = msg.content.some((block: any) => block?.type !== 'text');
    if (hasNonText) {
      throw new Error('Ollama cannot handle non-text content blocks');
    }
    content = msg.content
      .map((block: any) => (typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  } else {
    content = '';
  }
  return {
    role: msg.role as 'user' | 'assistant',
    content,
  };
}
```

- [x] **Step 3: Update chat() to pass tools and parse tool_calls from response**

In the `chat()` method, update the request body and response parsing:

```typescript
    async chat(params: OllamaChatParams): Promise<OllamaChatResult> {
      const url = process.env.OLLAMA_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
      const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 15000;

      const ollamaMessages = params.messages.map(toOllamaMessage);
      if (params.system) {
        ollamaMessages.unshift({ role: 'system', content: params.system });
      }

      const body: Record<string, unknown> = {
        model,
        stream: false,
        messages: ollamaMessages,
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = params.signal
        ? AbortSignal.any([params.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`Ollama error ${res.status}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error(`Ollama returned invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
      }

      const text = data?.message?.content ?? '';
      const toolCalls: OllamaToolCall[] | undefined = data?.message?.tool_calls;

      return { text, toolCalls: toolCalls?.length ? toolCalls : undefined };
    },
```

Note: `text` now defaults to `''` instead of throwing when missing, because tool-calling responses may have no content.

- [x] **Step 4: Add helper to convert ToolDefinition to Ollama format**

Add an exported helper function at the bottom of the file:

```typescript
export function toOllamaToolDef(tool: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }): OllamaToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
```

- [x] **Step 5: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 6: Commit**

```bash
git add packages/server/src/ai/ollama.ts
git commit -m "feat: add native tool calling support to Ollama client"
```

---

### Task 6: Create Ollama tool-loop

**Files:**
- Create: `packages/server/src/ai/ollama-tool-loop.ts`

- [x] **Step 1: Create the Ollama tool-loop**

Create `packages/server/src/ai/ollama-tool-loop.ts`:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolDefinition } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient, OllamaToolCall } from './ollama.js';
import { toOllamaToolDef } from './ollama.js';
import { executeToolWithPermission, deanonDeep } from './tool-helpers.js';
import { shouldEscalate } from './escalation-check.js';
import crypto from 'node:crypto';

const MAX_ITERATIONS = 10;

interface OllamaToolLoopParams {
  messages: MessageParam[];
  ollama: OllamaClient;
  tools: ToolDefinition[];
  system: string;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
}

interface OllamaToolLoopResult {
  escalate: boolean;
  reason: string;
}

/**
 * Ollama tool message format: role 'tool' with the result content.
 * We build these as MessageParam-compatible objects that toOllamaMessage
 * will handle, but since Ollama uses a different message format for tool
 * results, we track them separately.
 */
interface OllamaToolResultMessage {
  role: 'tool';
  content: string;
}

type OllamaLoopMessage = MessageParam | OllamaToolResultMessage;

export async function runOllamaToolLoop(params: OllamaToolLoopParams): Promise<OllamaToolLoopResult> {
  const { ollama, tools, system, onEvent, signal, pendingConfirms, pendingPlanReviews, piiProxy } = params;

  const ollamaTools = tools.map(toOllamaToolDef);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // Build message history — we maintain our own list since Ollama uses
  // a different format for tool result messages.
  const loopMessages: OllamaLoopMessage[] = [...params.messages];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return { escalate: false, reason: '' };
    iterations++;

    const result = await ollama.chat({
      messages: loopMessages as MessageParam[],
      system,
      signal,
      tools: ollamaTools,
    });

    if (signal?.aborted) return { escalate: false, reason: '' };

    // No tool calls — check for escalation or return text
    if (!result.toolCalls) {
      const decision = shouldEscalate(result.text);
      if (decision.escalate) {
        return { escalate: true, reason: decision.reason };
      }

      // Deanonymize and emit final text
      const deanonText = await piiProxy.deanonymize(result.text);
      if (signal?.aborted) return { escalate: false, reason: '' };
      onEvent({ type: 'text_delta', content: deanonText });
      return { escalate: false, reason: '' };
    }

    // Execute each tool call
    for (const tc of result.toolCalls) {
      if (signal?.aborted) return { escalate: false, reason: '' };

      const toolDef = toolMap.get(tc.function.name);
      if (!toolDef) {
        // Unknown tool — add error result and continue
        const blockId = crypto.randomUUID();
        onEvent({
          type: 'tool_call_start',
          toolCall: { id: blockId, name: tc.function.name, input: tc.function.arguments, status: 'running' },
        });
        const errorResult = { success: false as const, error: `Unknown tool: ${tc.function.name}` };
        onEvent({ type: 'tool_call_result', id: blockId, result: errorResult });
        loopMessages.push(
          { role: 'assistant', content: `Calling tool: ${tc.function.name}` } as MessageParam,
          { role: 'tool', content: JSON.stringify(errorResult) },
        );
        continue;
      }

      // Deanonymize tool input
      const deanonInput = await deanonDeep(tc.function.arguments, piiProxy);

      const blockId = crypto.randomUUID();
      const { result: toolResult } = await executeToolWithPermission({
        toolDef,
        blockId,
        input: deanonInput as Record<string, unknown>,
        onEvent,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        signal,
      });

      // Add assistant tool call + tool result to history for next iteration
      loopMessages.push(
        { role: 'assistant', content: `Calling tool: ${toolDef.name}` } as MessageParam,
        { role: 'tool', content: JSON.stringify(toolResult.success ? (toolResult.data ?? '') : (toolResult.error ?? 'Unknown error')) },
      );
    }
  }

  // Max iterations — emit warning
  onEvent({ type: 'text_delta', content: 'Досягнуто максимальну кількість ітерацій tools.' });
  return { escalate: false, reason: '' };
}

```

- [x] **Step 2: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/server/src/ai/ollama-tool-loop.ts
git commit -m "feat: add Ollama tool-loop for native tool calling"
```

---

### Task 7: Update router to use Ollama tool calling

**Files:**
- Modify: `packages/server/src/ai/router.ts`

- [x] **Step 1: Add registry and tool-loop imports to RunChatRequestParams**

In `packages/server/src/ai/router.ts`, update imports and params:

```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent } from '@r2/shared';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from './ollama.js';
import type { ToolRegistry } from '../tools/registry.js';
import { shouldEscalate } from './escalation-check.js';
import { getLocalSystemPrompt } from './prompts.js';
import { toOllamaToolDef } from './ollama.js';
import { runOllamaToolLoop } from './ollama-tool-loop.js';

export interface RunChatRequestParams {
  messages: MessageParam[];
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
}
```

- [x] **Step 2: Update runChatRequest to pass tools to Ollama and handle tool_calls**

Replace the Ollama call section in `runChatRequest` (lines 110-130) with:

```typescript
  let ollamaText: string | null = null;
  let ollamaToolCalls: import('./ollama.js').OllamaToolCall[] | undefined;
  let piiEntities: Array<{ type: string; original: string }> = [];
  try {
    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    piiEntities = anonymized.entities;

    // Get tools available to Ollama
    const ollamaTools = params.registry.getForProvider('ollama');
    const ollamaToolDefs = ollamaTools.map(toOllamaToolDef);

    const result = await params.ollama.chat({
      messages: anonymized.messages,
      system: getLocalSystemPrompt(),
      signal: params.signal,
      tools: ollamaToolDefs.length > 0 ? ollamaToolDefs : undefined,
    });
    ollamaText = result.text;
    ollamaToolCalls = result.toolCalls;
  } catch (err) {
    if (params.signal?.aborted) return;
    console.warn(
      '[router] Ollama unreachable, falling back to Claude:',
      err instanceof Error ? err.message : err,
    );
    await callClaudeFallback(params);
    return;
  }
```

- [x] **Step 3: Add tool_calls handling branch before escalation check**

After the Ollama call, replace the escalation check section (lines 132-177) with:

```typescript
  // If Ollama called tools, run the Ollama tool-loop
  if (ollamaToolCalls) {
    if (params.signal?.aborted) return;

    if (piiEntities.length > 0) {
      params.onEvent({ type: 'pii_masked', entities: piiEntities });
    }
    params.onEvent({ type: 'assistant_source', source: 'ollama' });

    const anonymized = await anonymizeMessages(params.messages, params.piiProxy);
    const ollamaTools = params.registry.getForProvider('ollama');

    const loopResult = await runOllamaToolLoop({
      messages: anonymized.messages,
      ollama: params.ollama!,
      tools: ollamaTools,
      system: getLocalSystemPrompt(),
      onEvent: params.onEvent,
      signal: params.signal,
      pendingConfirms: params.pendingConfirms ?? new Map(),
      pendingPlanReviews: params.pendingPlanReviews ?? new Map(),
      piiProxy: params.piiProxy,
    });

    if (loopResult.escalate) {
      // Ollama tool-loop decided to escalate — hand off to Claude
      const escalationMessage = `Escalating to Claude (${loopResult.reason})`;
      params.onEvent({
        type: 'tool_call_start',
        toolCall: { id: 'router', name: 'router', input: { reason: loopResult.reason }, status: 'running' },
      });
      params.onEvent({ type: 'tool_progress', id: 'router', message: escalationMessage });
      params.onEvent({
        type: 'tool_call_result',
        id: 'router',
        result: { success: true, display: { type: 'text', content: escalationMessage } },
      });
      await callClaudeFallback(params);
      return;
    }

    params.onEvent({ type: 'done' });
    return;
  }

  // Text-only response — check for escalation markers
  const decision = shouldEscalate(ollamaText!);

  if (decision.escalate) {
    if (params.signal?.aborted) return;
    const escalationMessage = `Escalating to Claude (${decision.reason})`;
    params.onEvent({
      type: 'tool_call_start',
      toolCall: { id: 'router', name: 'router', input: { reason: decision.reason }, status: 'running' },
    });
    params.onEvent({ type: 'tool_progress', id: 'router', message: escalationMessage });
    params.onEvent({
      type: 'tool_call_result',
      id: 'router',
      result: { success: true, display: { type: 'text', content: escalationMessage } },
    });
    await callClaudeFallback(params);
    return;
  }

  if (piiEntities.length > 0) {
    params.onEvent({ type: 'pii_masked', entities: piiEntities });
  }

  const deanonText = await params.piiProxy.deanonymize(ollamaText!);
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'assistant_source', source: 'ollama' });
  params.onEvent({ type: 'text_delta', content: deanonText });
  if (params.signal?.aborted) return;
  params.onEvent({ type: 'done' });
```

- [x] **Step 4: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: Compilation error — `registry` is not yet passed to `runChatRequest` from chat.ts and index.ts. We fix this in the next step.

- [x] **Step 5: Update chat.ts to pass registry**

In `packages/server/src/routes/chat.ts`, update `ChatRouterDeps` interface to include `registry`:

```typescript
import type { ToolRegistry } from '../tools/registry.js';

interface ChatRouterDeps {
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms?: PendingConfirms;
    pendingPlanReviews?: PendingPlanReviews;
    piiProxy: PiiProxy;
  }) => Promise<void>;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  registry: ToolRegistry;
}
```

Update the `createChatRouter` function signature:

```typescript
export function createChatRouter({ runLoop, pendingConfirms, pendingPlanReviews, piiProxy, ollama, registry }: ChatRouterDeps): Router {
```

And pass `registry` to `runChatRequest`:

```typescript
      await runChatRequest({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        pendingPlanReviews,
        piiProxy,
        ollama,
        registry,
        runLoop,
        onEvent: (event: SSEEvent) => {
          // ... existing event handler unchanged
```

- [x] **Step 6: Update index.ts to pass registry to chatRouter**

In `packages/server/src/index.ts`, update the `createChatRouter` call (line 114):

```typescript
const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, pendingPlanReviews: ppr, piiProxy: pp }),
  pendingConfirms,
  pendingPlanReviews,
  piiProxy,
  ollama,
  registry,
});
```

- [x] **Step 7: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS

- [x] **Step 8: Commit**

```bash
git add packages/server/src/ai/router.ts packages/server/src/routes/chat.ts packages/server/src/index.ts
git commit -m "feat: integrate Ollama tool calling into router"
```

---

### Task 8: Update Ollama system prompt

**Files:**
- Modify: `packages/server/src/ai/prompts.ts:41-94`

- [x] **Step 1: Update getLocalSystemPrompt**

Replace the `getLocalSystemPrompt()` function in `packages/server/src/ai/prompts.ts`:

```typescript
export function getLocalSystemPrompt(): string {
  return `Ти — R2, персональний AI-асистент. Ти працюєш для свого власника.
Твоя задача — робити рутину, щоб власник міг думати про важливе.

Зараз: ${formatNow()}.

${BASE_RULES}

У тебе є інструменти (tools) для пошуку в інтернеті та роботи з файлами.
Використовуй їх коли потрібно — вони викликаються автоматично.

ОБМЕЖЕННЯ:
У тебе НЕМАЄ доступу до bash, баз даних, API чи програмування.
Якщо потрібна задача програмування або інша складна дія — поверни РІВНО один рядок:

  [need tool: <що саме потрібно зробити>]

На прості фактичні питання зі своєї пам'яті відповідай напряму, коротко.
Ніколи не змішуй маркер з іншим текстом — або маркер сам, або звичайна відповідь.`;
}
```

- [x] **Step 2: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/server/src/ai/prompts.ts
git commit -m "feat: update Ollama prompt for native tool calling"
```

---

### Task 9: Update escalation check for tool-only markers

**Files:**
- Modify: `packages/server/src/ai/escalation-check.ts`

- [x] **Step 1: Remove search-specific triggers, keep tool/code markers**

Now that Ollama can search natively, the `[need search: ...]` marker should no longer trigger escalation. Update `TRIGGER_PATTERNS` in `packages/server/src/ai/escalation-check.ts`:

```typescript
const TRIGGER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bI\s+(need\s+to|cannot|can'?t)\b[^.]*?\b(tool|access)\b/i, reason: 'requires tool (english)' },
  { pattern: /(я\s+не\s+могу|мне\s+нужно|я\s+должен)[^.]*?(инструмент|tool|доступ)/i, reason: 'requires tool (russian)' },
  { pattern: /(потріб\w*|не\s+можу|мушу|треба)[^.]*?(зовнішн\w*|інструмент\w*|доступ\w*)/i, reason: 'requires tool (ukrainian)' },
  { pattern: /\[need\s+(code|tool)\b[^\]]*\]/i, reason: 'bracket marker' },
];
```

Key changes:
- Removed `web\s+search|search` from English pattern
- Removed `поиск` from Russian pattern
- Removed `пошук\w*` from Ukrainian pattern
- Removed `search|file` from bracket marker pattern (Ollama handles these natively now)
- Removed `let me search/look up/find` pattern entirely

- [x] **Step 2: Build to verify**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add packages/server/src/ai/escalation-check.ts
git commit -m "feat: narrow escalation triggers — Ollama handles search/files natively"
```

---

### Task 10: End-to-end smoke test

**Files:** none (manual testing)

- [ ] **Step 1: Build entire project**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS — all packages compile

- [ ] **Step 2: Start the server and test Ollama tool calling**

Run: `cd /Users/dim/code/R2-D2 && npm run dev`

Test scenarios in the chat UI:
1. Ask "Яка погода в Одесі?" — Ollama should call `web_search` tool natively (not escalate)
2. Ask "Покажи файли" — Ollama should call `file_list` tool natively
3. Ask "Напиши функцію на Python" — Ollama should escalate to Claude (code_task is Claude-only)
4. Ask "Столиця Франції?" — Ollama answers from memory, no tools

- [ ] **Step 3: Verify tool permissions work with Ollama**

Test `file_write` via Ollama — should trigger confirmation dialog same as with Claude.

- [ ] **Step 4: Verify escalation still works**

Confirm that when Ollama emits `[need tool: ...]` for Claude-only tasks, the escalation happens and Claude takes over.
