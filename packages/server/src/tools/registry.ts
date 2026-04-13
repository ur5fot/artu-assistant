import type { ToolDefinition } from '@r2/shared';
import type { ToolDeps } from './base.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  getForProvider(provider: 'ollama' | 'claude'): ToolDefinition[];
  getCommands(): Array<{
    name: string;
    tool: string;
    description: string;
    params?: Array<{ name: string; required: boolean; description?: string }>;
    flags?: Array<{ token: string; param: string; description?: string }>;
  }>;
  getByCommandName(commandName: string): ToolDefinition | undefined;
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" already registered`);
      }
      if (tool.command) {
        const existing = [...tools.values()].find((t) => t.command?.name === tool.command!.name);
        if (existing) {
          throw new Error(`Command "/${tool.command.name}" already registered by tool "${existing.name}"`);
        }
      }
      tools.set(tool.name, tool);
    },

    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },

    getAll(): ToolDefinition[] {
      return [...tools.values()];
    },

    getForProvider(provider: 'ollama' | 'claude'): ToolDefinition[] {
      return [...tools.values()].filter(
        (t) => t.provider === provider || t.provider === 'all',
      );
    },

    getCommands() {
      return [...tools.values()]
        .filter((t) => t.command)
        .map((t) => ({
          name: t.command!.name,
          tool: t.name,
          description: t.command!.description,
          params: t.command!.params,
          flags: t.command!.flags,
        }));
    },

    getByCommandName(commandName: string): ToolDefinition | undefined {
      return [...tools.values()].find((t) => t.command?.name === commandName);
    },
  };
}

export async function discoverTools(
  registry?: ToolRegistry,
  deps?: ToolDeps,
  packagesDir?: string,
): Promise<ToolRegistry> {
  const reg = registry ?? createRegistry();
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
    return reg;
  }

  for (const entry of entries) {
    const toolPackageName = `@r2/${entry}`;
    try {
      let mod: any;
      try {
        mod = await import(toolPackageName);
      } catch {
        // Fallback: import by path (for non-linked packages)
        const pkgJsonPath = path.join(dir, entry, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          const main = pkgJson.main || 'index.js';
          const entryPath = path.resolve(dir, entry, main);
          mod = await import(pathToFileURL(entryPath).href);
        } else {
          throw new Error(`Cannot resolve ${toolPackageName}`);
        }
      }

      let toRegister: ToolDefinition[] = [];

      if (typeof mod.createTool === 'function') {
        if (!deps) {
          console.warn(
            `WARNING: Tool package ${entry} exports createTool factory but no deps were provided; skipping.`,
          );
          continue;
        }
        const result = mod.createTool(deps);
        toRegister = Array.isArray(result) ? result : [result];
      } else if (mod.default) {
        toRegister = Array.isArray(mod.default) ? mod.default : [mod.default];
      }

      for (const tool of toRegister) {
        if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
          reg.register(tool);
          console.log(`  Tool discovered: ${tool.name} (${entry})`);
        }
      }
    } catch (err) {
      console.error(`  Failed to load tool ${entry}:`, err instanceof Error ? err.message : err);
    }
  }

  const toolCount = reg.getAll().length;
  if (toolCount === 0) {
    console.warn('WARNING: No tools were discovered. The assistant will not be able to use any tools.');
  } else {
    console.log(`Tools loaded: ${toolCount}`);
  }
  return reg;
}
