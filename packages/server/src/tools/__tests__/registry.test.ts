import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRegistry, discoverTools } from '../registry.js';
import type { ToolDefinition } from '../base.js';
import path from 'node:path';
import fs from 'node:fs';

const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
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
    const packagesDir = path.resolve(process.cwd(), 'packages');
    // tool-web-search should exist from Phase 1
    const hasWebSearch = fs.existsSync(path.join(packagesDir, 'tool-web-search'));
    if (!hasWebSearch) return; // skip if not in full repo context

    const registry = await discoverTools();
    const tools = registry.getAll();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.some((t) => t.name === 'web_search')).toBe(true);
  });

  it('returns empty registry when no tool packages exist', async () => {
    // Pass a directory with no tool-* packages
    const registry = await discoverTools('/tmp/nonexistent-dir-r2-test');
    expect(registry.getAll()).toHaveLength(0);
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
