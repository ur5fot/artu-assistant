import type { ToolDefinition, ToolResult } from '@r2/shared';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function getEvalsPath(): string {
  return process.env.EVALS_PATH || path.resolve(process.cwd(), 'data', 'evals.json');
}

function loadList(): any[] {
  const filePath = getEvalsPath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(list: any[]): void {
  const filePath = getEvalsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(list, null, 2));
  fs.renameSync(tmpPath, filePath);
}

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
      const list = loadList();
      list.push(newEval);
      writeList(list);

      return {
        success: true,
        data: { id: newEval.id, totalEvals: list.length },
        display: {
          type: 'text',
          content: `Saved eval "${newEval.id}". Total evals: ${list.length}.`,
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
