import type { ToolDefinition, ToolResult } from '@r2/shared';
import { loadEvals, saveEval } from '@r2/server/evals/store.js';
import crypto from 'node:crypto';

export const evalAddTool: ToolDefinition = {
  name: 'eval_add',
  description: 'Save a new behavior eval for R2. Use when user says "this is wrong, should be X", or explicitly asks to remember correct behavior. Persists to data/evals.json for pre-merge regression checks.',
  permissionLevel: 'confirm',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The user message that triggered the wrong behavior' },
      expected: { type: 'string', description: 'Natural language description of correct behavior' },
      toolUseExpected: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional: tools R2 must call to pass this eval',
      },
    },
    required: ['input', 'expected'],
  },
  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const input = typeof params.input === 'string' ? params.input.trim() : '';
    const expected = typeof params.expected === 'string' ? params.expected.trim() : '';
    const toolUseExpected = Array.isArray(params.toolUseExpected)
      ? (params.toolUseExpected as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;

    if (input.length === 0) {
      return { success: false, error: 'input is required' };
    }
    if (expected.length === 0) {
      return { success: false, error: 'expected is required' };
    }

    const newEval = {
      id: crypto.randomUUID(),
      input,
      expected,
      toolUseExpected: toolUseExpected && toolUseExpected.length > 0 ? toolUseExpected : null,
      createdAt: new Date().toISOString(),
    };

    try {
      await saveEval(newEval);
      const total = (await loadEvals()).length;

      return {
        success: true,
        data: { id: newEval.id, totalEvals: total },
        display: {
          type: 'text',
          content: `Saved eval "${newEval.id}". Total evals: ${total}.`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'failed to save eval',
      };
    }
  },
};

export default evalAddTool;
