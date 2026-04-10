import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { SSEEvent, ToolCall, ToolResult, PlanReviewResponse, ToolContext } from '@r2/shared';
import type { ClaudeClient } from './claude.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ConfirmResponse, PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import { toClaudeTool } from '../tools/base.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';
import type { PiiProxy } from '../pii/proxy.js';

const MAX_ITERATIONS = 10;

async function deanonDeep(value: unknown, piiProxy: PiiProxy): Promise<unknown> {
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

interface ToolLoopParams {
  messages: MessageParam[];
  client: ClaudeClient;
  registry: ToolRegistry;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  piiProxy: PiiProxy;
}

async function requestConfirmation(
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

function createPlanReviewRequester(
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

function buildToolContext(
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

export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
  pendingPlanReviews = new Map(),
  piiProxy,
}: ToolLoopParams): Promise<void> {
  const allTools = registry.getAll();
  const tools: Tool[] = allTools.map(toClaudeTool) as Tool[];
  let currentMessages: MessageParam[] = [...messages];
  let iterations = 0;
  let lastEndedWithToolUse = false;

  // Anonymize user messages before sending to Claude
  const anonymizedMessages: MessageParam[] = [];
  const allPiiEntities: Array<{ type: string; token: string; original: string }> = [];
  for (const msg of currentMessages) {
    if (signal?.aborted) return;
    if (typeof msg.content === 'string') {
      const result = await piiProxy.anonymize(msg.content);
      anonymizedMessages.push({ role: msg.role, content: result.text });
      if (msg.role === 'user') allPiiEntities.push(...result.entities);
    } else {
      anonymizedMessages.push(msg);
    }
  }
  currentMessages = anonymizedMessages;

  // Emit pii_masked event if any PII was found
  if (allPiiEntities.length > 0) {
    onEvent({
      type: 'pii_masked',
      entities: allPiiEntities.map((e) => ({ type: e.type, original: e.original })),
    });
  }

  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) return;
    iterations++;

    const response = await client.sendMessage({
      messages: currentMessages,
      tools,
      signal,
    });

    if (signal?.aborted) return;

    const textBlocks = response.content.filter((b) => b.type === 'text');
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    // Emit text
    for (const block of textBlocks) {
      if (block.type === 'text') {
        const deanonText = await piiProxy.deanonymize(block.text);
        onEvent({ type: 'text_delta', content: deanonText });
      }
    }

    // No tool calls — done
    if (toolUseBlocks.length === 0 || response.stop_reason !== 'tool_use') {
      lastEndedWithToolUse = false;
      break;
    }

    lastEndedWithToolUse = true;

    // Execute tools and collect results
    const toolResultContents: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      if (signal?.aborted) return;

      // Recursively deanonymize all string values in tool input
      const deanonInput = await deanonDeep(block.input, piiProxy) as Record<string, unknown>;

      const toolCall: ToolCall = {
        id: block.id,
        name: block.name,
        input: deanonInput as Record<string, unknown>,
        status: 'running',
      };
      onEvent({ type: 'tool_call_start', toolCall });

      const toolDef = registry.get(block.name);
      let result: ToolResult;

      const startTime = Date.now();
      if (!toolDef) {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      } else if (toolDef.permissionLevel === 'confirm' || toolDef.permissionLevel === 'forbidden') {
        let allowed: boolean | null = null;
        let autoMode = false;
        let destructiveWarning: { reason: string } | undefined;

        // Run preCheck if defined (generic hook, not tool-specific)
        if (toolDef.preCheck) {
          try {
            const check = await toolDef.preCheck(deanonInput);
            if (check.destructive) {
              destructiveWarning = { reason: check.reason };
              allowed = null; // Force confirmation even if saved rule
            }
          } catch (err) {
            console.error('preCheck failed:', err instanceof Error ? err.message : err);
            // Fail closed: a broken preCheck must not silently bypass the
            // destructive-action gate. Force confirmation and drop any saved
            // auto-allow rule for this call.
            destructiveWarning = { reason: 'precheck failed — review manually' };
            allowed = null;
          }
        }

        // Check saved permission rule (only if not destructive)
        if (allowed === null && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
          try {
            const rule = getPermissionRule(block.name);
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
            block.id,
            toolCall,
            toolDef.permissionLevel,
            onEvent,
            pendingConfirms,
            signal,
            destructiveWarning,
          );
          allowed = confirmResponse.allowed;

          if (confirmResponse.remember && toolDef.permissionLevel === 'confirm' && !destructiveWarning) {
            try {
              savePermissionRule(block.name, confirmResponse.allowed);
            } catch (err) {
              console.error('Failed to save permission rule:', err instanceof Error ? err.message : err);
            }
          }
        }

        if (allowed) {
          try {
            const task = typeof deanonInput.task === 'string' ? deanonInput.task : '';
            const ctx = buildToolContext(block.id, task, autoMode, onEvent, pendingPlanReviews, signal);
            result = await toolDef.handler(deanonInput, ctx);
          } catch (err) {
            result = {
              success: false,
              error: err instanceof Error ? err.message : 'Unknown error',
            };
          }
        } else {
          result = { success: false, error: 'Action denied by user' };
        }
      } else {
        try {
          const task = typeof deanonInput.task === 'string' ? deanonInput.task : '';
          const ctx = buildToolContext(block.id, task, false, onEvent, pendingPlanReviews, signal);
          result = await toolDef.handler(deanonInput, ctx);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
      const durationMs = Date.now() - startTime;

      // Split heavy presentational fields off BEFORE PII anonymization so the
      // full diff (tens of KB from code_task) never gets stringified, sent
      // through Presidio, or fed back to Claude. The client still receives
      // fullDiff via the tool_call_result event below.
      let fullDiffSideChannel: unknown = undefined;
      if (result.success && result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        const data = result.data as Record<string, unknown>;
        if ('fullDiff' in data) {
          fullDiffSideChannel = data.fullDiff;
          const { fullDiff: _fd, ...rest } = data;
          result = { ...result, data: rest };
        }
      }

      // Anonymize the (slim) tool result before logging and sending back to Claude
      if (result.data) {
        const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
        if (anonResult.entities.length > 0) {
          try {
            result = { ...result, data: JSON.parse(anonResult.text) };
          } catch {
            // Token replacement broke JSON structure (e.g. PII in numeric values);
            // fall back to the anonymized string representation
            result = { ...result, data: anonResult.text };
          }
        }
      }

      try {
        logToolCall({
          toolName: block.name,
          input: block.input as Record<string, unknown>,
          result,
          success: result.success,
          durationMs,
        });
      } catch (err) {
        console.error('Audit log write failed:', err instanceof Error ? err.message : err);
      }

      // Re-attach fullDiff for the client event so the UI can render the full
      // diff. Claude still receives `result` without fullDiff below.
      const clientResult =
        fullDiffSideChannel !== undefined &&
        result.data &&
        typeof result.data === 'object' &&
        !Array.isArray(result.data)
          ? { ...result, data: { ...(result.data as Record<string, unknown>), fullDiff: fullDiffSideChannel } }
          : result;
      onEvent({ type: 'tool_call_result', id: block.id, result: clientResult });

      toolResultContents.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result.success ? (result.data ?? '') : (result.error ?? 'Unknown error')),
        ...(result.success ? {} : { is_error: true }),
      });
    }

    // Continue conversation with tool results
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResultContents },
    ];
  }

  // If we hit max iterations without Claude giving a final text answer, ask it to wrap up
  if (iterations >= MAX_ITERATIONS && lastEndedWithToolUse && !signal?.aborted) {
    const finalResponse = await client.sendMessage({
      messages: [
        ...currentMessages,
        { role: 'user', content: 'Max tool iterations reached. Give a final answer now.' },
      ],
      tools: [],
      signal,
    });

    for (const block of finalResponse.content) {
      if (block.type === 'text') {
        const deanonText = await piiProxy.deanonymize(block.text);
        onEvent({ type: 'text_delta', content: deanonText });
      }
    }
  }

  onEvent({ type: 'done' });
}
