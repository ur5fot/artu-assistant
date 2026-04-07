import type { ToolDefinition } from './base.js';
import fs from 'node:fs';
import path from 'node:path';

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
  const dir = packagesDir ?? path.resolve(process.cwd(), 'packages');

  let entries: string[];
  if (!fs.existsSync(dir)) {
    return registry;
  }
  entries = fs.readdirSync(dir).filter((name) => name.startsWith('tool-'));

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

  console.log(`Tools loaded: ${registry.getAll().length}`);
  return registry;
}
