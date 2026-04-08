import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRegistry, discoverTools } from '../registry.js';
import type { ToolDefinition } from '../base.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  permissionLevel: 'auto',
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
});

describe('discoverTools', () => {
  it('discovers and registers tool packages from packages/tool-*', async () => {
    // Resolve packages dir relative to this test file, not cwd
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const packagesDir = path.resolve(thisDir, '..', '..', '..', '..');
    // tool-web-search should exist from Phase 1
    const hasWebSearch = fs.existsSync(path.join(packagesDir, 'tool-web-search'));
    if (!hasWebSearch) return; // skip if not in full repo context

    const registry = await discoverTools(packagesDir);
    const tools = registry.getAll();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === 'web_search')).toBe(true);
  });

  it('returns empty registry when no tool packages exist', async () => {
    // Pass a directory with no tool-* packages
    const registry = await discoverTools('/tmp/nonexistent-dir-r2-test');
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

    const registry = await discoverTools(tmpDir);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get('tool_a')).toBeDefined();
    expect(registry.get('tool_b')).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips tool packages that fail to import without crashing', async () => {
    // Create a temp directory with a tool-* entry that cannot be resolved as an npm package
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'r2-discover-test-'));
    const brokenToolDir = path.join(tmpDir, 'tool-broken');
    fs.mkdirSync(brokenToolDir);

    // discoverTools scans for tool-* dirs then imports @r2/<name> via Node resolution
    // Since @r2/tool-broken is not an installed package, the import fails gracefully
    const registry = await discoverTools(tmpDir);
    expect(registry.getAll()).toHaveLength(0);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
