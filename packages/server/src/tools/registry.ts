import type { ToolDefinition } from './base.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" already registered`);
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getAll(): ToolDefinition[] {
      return [...tools.values()];
    },
  };
}

export async function discoverTools(packagesDir?: string): Promise<ToolRegistry> {
  const registry = createRegistry();
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const dir = packagesDir ?? path.resolve(thisDir, '..', '..', '..');

  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((name) => name.startsWith('tool-'));
  } catch (err) {
    console.warn(
      `WARNING: Could not read packages directory "${dir}":`,
      err instanceof Error ? err.message : err,
    );
    console.warn('WARNING: No tools were discovered. The assistant will not be able to use any tools.');
    return registry;
  }

  for (const entry of entries) {
    const toolPackageName = `@r2/${entry}`;
    try {
      const mod = await import(toolPackageName);
      const tool: ToolDefinition = mod.default;
      if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
        registry.register(tool);
        console.log(`  Tool discovered: ${tool.name} (${entry})`);
      }
    } catch (err) {
      console.error(`  Failed to load tool ${entry}:`, err instanceof Error ? err.message : err);
    }
  }

  const toolCount = registry.getAll().length;
  if (toolCount === 0) {
    console.warn('WARNING: No tools were discovered. The assistant will not be able to use any tools.');
  } else {
    console.log(`Tools loaded: ${toolCount}`);
  }
  return registry;
}
