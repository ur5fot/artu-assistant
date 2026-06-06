import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRegistry, discoverTools } from '../registry.js';
import type { ToolDefinition } from '../base.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  permissionLevel: 'auto',
  provider: 'all',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async () => ({ success: true, data: 'ok' }),
};

describe('Tool Registry', () => {
  it('registers and retrieves a tool', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get('test_tool')).toBe(mockTool);
  });

  it('returns undefined for unknown tool', () => {
    const registry = createRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('prevents duplicate registration', () => {
    const registry = createRegistry();
    registry.register(mockTool);
    expect(() => registry.register(mockTool)).toThrow('already registered');
  });

  it('prevents duplicate command names', () => {
    const registry = createRegistry();
    registry.register({
      ...mockTool,
      name: 'tool_a',
      command: { name: 'пошук', description: 'Search' },
    });
    expect(() =>
      registry.register({
        ...mockTool,
        name: 'tool_b',
        command: { name: 'пошук', description: 'Another search' },
      }),
    ).toThrow('Command "/пошук" already registered by tool "tool_a"');
  });

  it('returns commands list from getCommands()', () => {
    const registry = createRegistry();
    registry.register({
      ...mockTool,
      name: 'web_search',
      command: { name: 'пошук', description: 'Пошук в інтернеті', params: [{ name: 'query', required: true }] },
    });
    registry.register({ ...mockTool, name: 'plain_tool' });

    const cmds = registry.getCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].name).toBe('пошук');
    expect(cmds[0].tool).toBe('web_search');
  });

  it('looks up tool by command name', () => {
    const registry = createRegistry();
    const tool = {
      ...mockTool,
      name: 'web_search',
      command: { name: 'пошук', description: 'Search' },
    };
    registry.register(tool);

    expect(registry.getByCommandName('пошук')).toBe(tool);
    expect(registry.getByCommandName('nonexistent')).toBeUndefined();
  });
});

describe('discoverTools', () => {
  it('discovers and registers tool packages from packages/tool-*', async () => {
    // Resolve packages dir relative to this test file, not cwd
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packagesDir = path.resolve(thisDir, '..', '..', '..', '..');
    // tool-web-search should exist from Phase 1
    const hasWebSearch = fs.existsSync(path.join(packagesDir, 'tool-web-search'));
    if (!hasWebSearch) return; // skip if not in full repo context

    const registry = await discoverTools(undefined, undefined, packagesDir);
    const tools = registry.getAll();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === 'web_search')).toBe(true);
  });

  it('discovers emails_list and emails_get when deps are provided', async () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packagesDir = path.resolve(thisDir, '..', '..', '..', '..');
    const hasEmails = fs.existsSync(path.join(packagesDir, 'tool-emails'));
    if (!hasEmails) return; // skip if not in full repo context

    const registry = createRegistry();
    await discoverTools(registry, {
      runLoop: vi.fn() as any,
      client: {} as any,
      registry,
      piiProxy: {
        async anonymize(t: string) { return { text: t, entities: [] }; },
        async deanonymize(t: string) { return t; },
      } as any,
      memoryService: null,
      reminderStore: null,
      emailStore: {
        fetchInWindow: () => [],
        findByPendingId: () => null,
        getLastSeenUid: () => 0,
        hasAccountState: () => false,
        updateLastSeenUid: () => {},
        setAccountError: () => {},
        getAccountError: () => null,
        insertPending: () => {},
        countPendingUndelivered: () => 0,
        fetchPendingUndelivered: () => [],
        markDelivered: () => {},
      } as any,
      imapClient: {
        fetchNewMessages: async () => [],
        fetchFullBody: async () => { throw new Error(); },
        getAccount: () => null,
      },
      weatherClient: null,
      resolveUserCoords: null,
      store: null,
      evalStore: null,
      presence: null,
    }, packagesDir);

    expect(registry.get('emails_list')).toBeTruthy();
    expect(registry.get('emails_get')).toBeTruthy();
  });

  it('discovers the activity tool and its handler returns a digest', async () => {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packagesDir = path.resolve(thisDir, '..', '..', '..', '..');
    const hasActivity = fs.existsSync(path.join(packagesDir, 'tool-activity'));
    if (!hasActivity) return; // skip if not in full repo context

    const registry = createRegistry();
    await discoverTools(registry, {
      runLoop: vi.fn() as any,
      client: {} as any,
      registry,
      piiProxy: {} as any,
      memoryService: null,
      reminderStore: null,
      emailStore: null,
      imapClient: null,
      weatherClient: null,
      resolveUserCoords: null,
      // Structural fakes — exercise the real createTool factory + ActivityDeps wiring.
      store: { findRowsInWindow: () => [] } as any,
      evalStore: { listEvalsInWindow: () => [] } as any,
      presence: { listAwayInWindow: () => [] } as any,
    }, packagesDir);

    const activity = registry.get('activity');
    expect(activity).toBeTruthy();
    const res = await activity!.handler({ period: 'today' });
    expect(res.success).toBe(true);
    expect((res.data as any).total_active_min).toBe(0);
  });

  it('returns empty registry when no tool packages exist', async () => {
    // Pass a directory with no tool-* packages
    const registry = await discoverTools(undefined, undefined, '/tmp/nonexistent-dir-r2-test');
    expect(registry.getAll()).toHaveLength(0);
  });

  it('registers tools from array exports', async () => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'r2-array-test-'));
    const toolDir = path.join(tmpDir, 'tool-multi');
    fs.mkdirSync(toolDir);
    fs.writeFileSync(path.join(toolDir, 'package.json'), JSON.stringify({
      name: '@r2/tool-multi',
      main: 'index.js',
    }));
    fs.writeFileSync(path.join(toolDir, 'index.js'), `
      module.exports.default = [
        {
          name: 'tool_a',
          description: 'Tool A',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {}, required: [] },
          handler: async () => ({ success: true }),
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          permissionLevel: 'confirm',
          parameters: { type: 'object', properties: {}, required: [] },
          handler: async () => ({ success: true }),
        },
      ];
    `);

    try {
      const registry = await discoverTools(undefined, undefined, tmpDir);
      expect(registry.getAll()).toHaveLength(2);
      expect(registry.get('tool_a')).toBeDefined();
      expect(registry.get('tool_b')).toBeDefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips tool packages that fail to import without crashing', async () => {
    // Create a temp directory with a tool-* entry that cannot be resolved as an npm package
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'r2-discover-test-'));
    const brokenToolDir = path.join(tmpDir, 'tool-broken');
    fs.mkdirSync(brokenToolDir);

    // discoverTools scans for tool-* dirs then imports @r2/<name> via Node resolution
    // Since @r2/tool-broken is not an installed package, the import fails gracefully
    const registry = await discoverTools(undefined, undefined, tmpDir);
    expect(registry.getAll()).toHaveLength(0);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('discoverTools with factory support', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-registry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createFakeToolPackage(name: string, exportCode: string) {
    const pkgDir = path.join(tmpDir, name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: `@r2/${name}`,
      main: 'index.mjs',
    }));
    fs.writeFileSync(path.join(pkgDir, 'index.mjs'), exportCode);
  }

  it('loads default export (backward compatibility)', async () => {
    await createFakeToolPackage('tool-echo', `
      export default {
        name: 'echo',
        description: 'echoes',
        permissionLevel: 'auto',
        parameters: { type: 'object', properties: {} },
        handler: async () => ({ success: true }),
      };
    `);

    const registry = createRegistry();
    await discoverTools(registry, undefined, tmpDir);

    expect(registry.get('echo')).toBeDefined();
  });

  it('loads createTool factory when deps provided', async () => {
    await createFakeToolPackage('tool-di', `
      export function createTool(deps) {
        return {
          name: 'di_tool',
          description: 'needs deps',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ success: true, data: { hasRunLoop: typeof deps.runLoop === 'function' } }),
        };
      }
    `);

    const registry = createRegistry();
    const deps = {
      runLoop: async () => {},
      client: {} as any,
      registry,
      piiProxy: {} as any,
      memoryService: null,
      reminderStore: null,
      emailStore: null,
      imapClient: null,
      weatherClient: null,
      resolveUserCoords: null,
      store: null,
      evalStore: null,
      presence: null,
    };
    await discoverTools(registry, deps, tmpDir);

    expect(registry.get('di_tool')).toBeDefined();
    const result = await registry.get('di_tool')!.handler({});
    expect((result.data as any).hasRunLoop).toBe(true);
  });

  it('skips factory packages when deps missing', async () => {
    await createFakeToolPackage('tool-di-only', `
      export function createTool(deps) {
        return {
          name: 'di_only',
          description: 'deps required',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {} },
          handler: async () => ({ success: true }),
        };
      }
    `);

    const registry = createRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await discoverTools(registry, undefined, tmpDir);

    expect(registry.get('di_only')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('di-only'));
    warnSpy.mockRestore();
  });
});
