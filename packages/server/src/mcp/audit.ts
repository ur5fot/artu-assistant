import type { ToolResult } from '@r2/shared';
import type { PiiProxy } from '../pii/proxy.js';
import { logToolCall } from '../db.js';
import { anonymizeJsonStringLeaves } from '../pii/anonymize-tree.js';

export interface AuditMcpToolCallParams {
  toolName: string;
  input: Record<string, unknown>;
  result: ToolResult;
  durationMs: number;
  /** When provided, input/result are anonymized before they are written. */
  piiProxy?: PiiProxy;
}

/**
 * Write an audit row for an MCP-driven tool call. The native chat path logs
 * every tool call via `logToolCall` ([tool-helpers.ts]); the MCP path runs
 * handlers directly, so without this the file/reminder/memory/email mutations
 * triggered from a Claude client would leave no audit trail. We mirror the
 * native path's at-rest policy: the row is anonymized (only string leaves go
 * through Presidio so numeric ids/timestamps are untouched), while the result
 * returned to the MCP client stays raw per the MCP design's PII note.
 *
 * Failures are swallowed (logged to stderr) — an audit write must never break a
 * tool call the user already ran.
 */
export async function auditMcpToolCall({
  toolName,
  input,
  result,
  durationMs,
  piiProxy,
}: AuditMcpToolCallParams): Promise<void> {
  try {
    let logInput: Record<string, unknown> = input;
    let logResult: unknown = result;
    if (piiProxy) {
      const anonInput = await anonymizeJsonStringLeaves(input, piiProxy);
      logInput =
        anonInput.value !== null && typeof anonInput.value === 'object' && !Array.isArray(anonInput.value)
          ? (anonInput.value as Record<string, unknown>)
          : { _raw: anonInput.value };
      logResult = (await anonymizeJsonStringLeaves(result, piiProxy)).value;
    }
    logToolCall({
      toolName,
      input: logInput,
      result: logResult,
      success: result.success,
      durationMs,
    });
  } catch (err) {
    console.error('MCP audit log write failed:', err instanceof Error ? err.message : err);
  }
}
