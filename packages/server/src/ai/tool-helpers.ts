import type {
  SSEEvent,
  ToolCall,
  ToolResult,
  ToolContext,
  ToolDefinition,
  PlanReviewResponse,
  MemoryConfirmPayload,
  MemoryConfirmResponse,
} from '@r2/shared';
import type { ConfirmResponse, PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { PiiProxy } from '../pii/proxy.js';
import { logToolCall, getPermissionRule, savePermissionRule } from '../db.js';
import { anonymizeJsonStringLeaves } from '../pii/anonymize-tree.js';

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

export function createMemoryConfirmRequester(
  callId: string,
  onEvent: (event: SSEEvent) => void,
  pendingMemoryConfirms: PendingMemoryConfirms,
  signal?: AbortSignal,
): (payload: Omit<MemoryConfirmPayload, 'id'>) => Promise<MemoryConfirmResponse> {
  return (payload) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ approved: false });
      return;
    }
    const onAbort = () => {
      pendingMemoryConfirms.delete(callId);
      resolve({ approved: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pendingMemoryConfirms.set(callId, (response) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(response);
    });
    onEvent({ type: 'tool_memory_confirm', payload: { id: callId, ...payload } });
  });
}

export function buildToolContext(
  blockId: string,
  task: string,
  autoMode: boolean,
  onEvent: (event: SSEEvent) => void,
  pendingPlanReviews: PendingPlanReviews,
  pendingMemoryConfirms: PendingMemoryConfirms,
  currentUserMessageId: string | undefined,
  currentUserMessageTimestamp: number | undefined,
  signal?: AbortSignal,
): ToolContext {
  return {
    onProgress: (message) => onEvent({ type: 'tool_progress', id: blockId, message }),
    requestPlanReview: createPlanReviewRequester(blockId, task, onEvent, pendingPlanReviews, signal),
    requestMemoryConfirm: createMemoryConfirmRequester(blockId, onEvent, pendingMemoryConfirms, signal),
    signal,
    meta: { autoMode, callId: blockId },
    currentUserMessageId,
    currentUserMessageTimestamp,
  };
}

/**
 * Execute a tool with permission checks, audit logging, and PII handling.
 * Returns the tool result (for LLM message history) and a client-facing result
 * (which may include heavy fields like fullDiff stripped from the LLM-facing one).
 */
export async function executeToolWithPermission(params: {
  toolDef: ToolDefinition;
  blockId: string;
  input: Record<string, unknown>;
  onEvent: (event: SSEEvent) => void;
  pendingConfirms: PendingConfirms;
  pendingPlanReviews: PendingPlanReviews;
  pendingMemoryConfirms: PendingMemoryConfirms;
  piiProxy: PiiProxy;
  currentUserMessageId?: string;
  currentUserMessageTimestamp?: number;
  signal?: AbortSignal;
}): Promise<{ result: ToolResult; clientResult: ToolResult }> {
  const {
    toolDef,
    blockId,
    input,
    onEvent,
    pendingConfirms,
    pendingPlanReviews,
    pendingMemoryConfirms,
    piiProxy,
    currentUserMessageId,
    currentUserMessageTimestamp,
    signal,
  } = params;

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
        const ctx = buildToolContext(blockId, task, autoMode, onEvent, pendingPlanReviews, pendingMemoryConfirms, currentUserMessageId, currentUserMessageTimestamp, signal);
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
      const ctx = buildToolContext(blockId, task, false, onEvent, pendingPlanReviews, pendingMemoryConfirms, currentUserMessageId, currentUserMessageTimestamp, signal);
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

  // Anonymize tool result before logging and sending back to LLM.
  // Walk the JSON tree and mask only string leaves — numeric fields like
  // timestamps must stay numbers so Presidio's regex recognizers don't
  // mis-classify them as CREDIT_CARD / PHONE_NUMBER.
  if (result.data) {
    const anon = await anonymizeJsonStringLeaves(result.data, piiProxy);
    if (anon.entities.length > 0) {
      result = { ...result, data: anon.value };
    }
  }

  // Audit log — anonymize input before writing to avoid PII at rest.
  // Same reasoning as the result block: only string leaves go through Presidio.
  try {
    const anonInput = await anonymizeJsonStringLeaves(input, piiProxy);
    const logInput =
      anonInput.value !== null && typeof anonInput.value === 'object' && !Array.isArray(anonInput.value)
        ? (anonInput.value as Record<string, unknown>)
        : { _raw: anonInput.value };
    logToolCall({ toolName: toolDef.name, input: logInput, result, success: result.success, durationMs });
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
