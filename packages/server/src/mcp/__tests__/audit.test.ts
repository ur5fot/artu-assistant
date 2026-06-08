import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { initDb, getDb, closeDb } from '../../db.js';
import type { PiiProxy } from '../../pii/proxy.js';
import { auditMcpToolCall } from '../audit.js';

/** Read all audit_log rows for assertions. */
function auditRows(): Array<{ tool_name: string; input: string; result: string; success: number }> {
  return getDb()
    .prepare('SELECT tool_name, input, result, success FROM audit_log ORDER BY id')
    .all() as Array<{ tool_name: string; input: string; result: string; success: number }>;
}

describe('auditMcpToolCall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-mcp-audit-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes an audit row for a successful tool call', async () => {
    await auditMcpToolCall({
      toolName: 'reminder_create',
      input: { text: 'drink water' },
      result: { success: true, data: { id: 1 } },
      durationMs: 12,
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe('reminder_create');
    expect(rows[0].success).toBe(1);
    expect(JSON.parse(rows[0].input)).toEqual({ text: 'drink water' });
  });

  it('records success=0 for a failed result', async () => {
    await auditMcpToolCall({
      toolName: 'memory_forget',
      input: { query: 'x' },
      result: { success: false, error: 'nope' },
      durationMs: 3,
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(0);
  });

  it('anonymizes string leaves of input and result when a piiProxy is given', async () => {
    // Stub proxy: replaces any string with a token, mirroring the real proxy's contract.
    const piiProxy: PiiProxy = {
      anonymize: async (text: string) => ({
        text: `<MASK:${text.length}>`,
        entities: [{ type: 'TEST', token: `<MASK:${text.length}>`, original: text }],
      }),
      deanonymize: async (text: string) => text,
    };
    await auditMcpToolCall({
      toolName: 'memory_update',
      input: { key: 'user.age', newValue: 'secret' },
      result: { success: true, data: { note: 'sensitive' } },
      durationMs: 5,
      piiProxy,
    });
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    const loggedInput = JSON.parse(rows[0].input);
    expect(loggedInput.newValue).toBe('<MASK:6>');
    expect(loggedInput.newValue).not.toContain('secret');
    expect(rows[0].result).not.toContain('sensitive');
  });

  it('never throws even if the DB is unavailable', async () => {
    closeDb();
    await expect(
      auditMcpToolCall({
        toolName: 'weather',
        input: {},
        result: { success: true },
        durationMs: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
