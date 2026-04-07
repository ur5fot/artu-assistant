import type { ToolDefinition } from './base.js';

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
