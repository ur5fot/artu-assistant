import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRegistry, type ToolRegistry } from '../../tools/registry.js';
import { initDb, getDb, closeDb } from '../../db.js';
import type { ToolDefinition } from '../../tools/base.js';
import {
  createReminderCreateTool,
  type ReminderStoreLike,
  type Schedule,
} from '@r2/tool-reminder';
import { createMcpServer } from '../server.js';

/** A real (temp) SQLite-backed reminder store — exercises the write path end-to-end. */
function makeTempStore(): { store: ReminderStoreLike; close: () => void; count: () => number } {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, schedule TEXT NOT NULL)',
  );
  const store: ReminderStoreLike = {
    create(text: string, schedule: Schedule): number {
      const info = db
        .prepare('INSERT INTO reminders (text, schedule) VALUES (?, ?)')
        .run(text, JSON.stringify(schedule));
      return Number(info.lastInsertRowid);
    },
    list() {
      return db
        .prepare('SELECT id, text, schedule FROM reminders')
        .all()
        .map((r: any) => ({
          id: r.id,
          text: r.text,
          schedule: JSON.parse(r.schedule),
          next_fire_at_ms: 0,
        }));
    },
    delete(id: number): boolean {
      return db.prepare('DELETE FROM reminders WHERE id = ?').run(id).changes > 0;
    },
  };
  return {
    store,
    close: () => db.close(),
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }).n,
  };
}

function readTool(name: string, content: string): ToolDefinition {
  return {
    name,
    description: `read ${name}`,
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    handler: async (params) => ({
      success: true,
      data: { echo: params },
      display: { type: 'text', content },
    }),
  };
}

function throwingTool(name: string): ToolDefinition {
  return {
    name,
    description: `throws ${name}`,
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      throw new Error('handler exploded');
    },
  };
}

function internalTool(name: string): ToolDefinition {
  return {
    name,
    description: `internal ${name}`,
    permissionLevel: 'auto',
    provider: 'all',
    parameters: { type: 'object', properties: {} },
    handler: async () => ({ success: true }),
  };
}

describe('createMcpServer (integration over InMemoryTransport)', () => {
  let temp: ReturnType<typeof makeTempStore>;
  let registry: ToolRegistry;
  let auditDir: string;
  // Track every Client/Server created so afterEach can close them — otherwise
  // the transport pairs leak across the suite.
  let open: Array<{ close: () => Promise<void> }>;

  /** Wire a Client to the MCP server over an in-memory transport pair. */
  async function connectClient(reg: ToolRegistry, denylist: string[] = []): Promise<Client> {
    const server = createMcpServer({ registry: reg, denylist });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    open.push(client, server);
    return client;
  }

  beforeEach(() => {
    // Real DB so the audit-log write path (createMcpServer → auditMcpToolCall →
    // logToolCall) runs end-to-end and can be asserted.
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-mcp-int-'));
    initDb(path.join(auditDir, 'test.db'));
    temp = makeTempStore();
    open = [];
    registry = createRegistry();
    registry.register(readTool('weather', 'It is 20°C in Kyiv'));
    registry.register(createReminderCreateTool({ reminderStore: temp.store }));
    registry.register(throwingTool('boom'));
    registry.register(internalTool('code_deploy')); // internal → must be excluded
  });

  afterEach(async () => {
    await Promise.all(open.map((c) => c.close()));
    temp.close();
    closeDb();
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  it('list_tools returns the exposed set and excludes internal tools', async () => {
    const client = await connectClient(registry);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['weather', 'reminder_create', 'boom']));
    expect(names).not.toContain('code_deploy');
    const weather = tools.find((t) => t.name === 'weather')!;
    expect(weather.inputSchema).toMatchObject({ type: 'object' });
  });

  it('calls a read tool and maps display.content to text content', async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'weather', arguments: { city: 'Kyiv' } });
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: 'text', text: 'It is 20°C in Kyiv' }]);
  });

  it('calls reminder_create and writes a row to the temp DB', async () => {
    const client = await connectClient(registry);
    expect(temp.count()).toBe(0);
    const res = await client.callTool({
      name: 'reminder_create',
      arguments: { text: 'выпить воды', kind: 'once', after_minutes: 5 },
    });
    expect(res.isError).toBeFalsy();
    expect(temp.count()).toBe(1);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('выпить воды');
    // The write must leave an audit trail (regression guard for the MCP path
    // that previously called handlers without logging).
    const audit = getDb()
      .prepare('SELECT tool_name, success FROM audit_log')
      .all() as Array<{ tool_name: string; success: number }>;
    expect(audit).toEqual([{ tool_name: 'reminder_create', success: 1 }]);
  });

  it('maps a tool reporting failure to isError', async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({
      name: 'reminder_create',
      arguments: { text: '', kind: 'once', after_minutes: 5 },
    });
    expect(res.isError).toBe(true);
    expect(temp.count()).toBe(0);
  });

  it('maps a thrown handler error to isError', async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('handler exploded');
  });

  it('returns isError for an unknown tool', async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(res.isError).toBe(true);
  });

  it('returns isError when calling a denylisted (internal) tool', async () => {
    const client = await connectClient(registry);
    const res = await client.callTool({ name: 'code_deploy', arguments: {} });
    expect(res.isError).toBe(true);
  });

  it('honours an extra MCP_TOOL_DENYLIST entry for both listing and calling', async () => {
    const client = await connectClient(registry, ['weather']);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('weather');
    const res = await client.callTool({ name: 'weather', arguments: { city: 'Kyiv' } });
    expect(res.isError).toBe(true);
  });
});
