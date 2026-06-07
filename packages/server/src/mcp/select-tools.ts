import type { ToolDefinition } from '../tools/base.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * R2-internal tools that must never be exposed over MCP. These either drive R2's
 * own deploy/eval machinery or mutate R2's system prompt. Prompt-overlay tools
 * carry `permissionLevel: 'confirm'` (not `forbidden`), so the `forbidden` filter
 * alone would not catch them — they must be named here explicitly.
 *
 * Names verified against:
 *   - tool-code-task (`code_task`, `task`), tool-code-deploy (`code_deploy`)
 *   - tool-eval (`eval_add`, `eval_run`)
 *   - tool-prompt-overlay CONFIGS (`prompt_overlay_claude`, `prompt_overlay_ollama`)
 */
export const INTERNAL_TOOL_DENYLIST: readonly string[] = [
  'code_deploy',
  'code_task',
  'task',
  'eval_add',
  'eval_run',
  'prompt_overlay_claude',
  'prompt_overlay_ollama',
];

/**
 * Select the tools to expose over MCP. Excludes the internal denylist, any
 * caller-supplied `extraDenylist` (from `MCP_TOOL_DENYLIST`), and any tool with
 * `permissionLevel: 'forbidden'`. Unknown denylist entries are harmless no-ops.
 */
export function selectMcpTools(
  registry: ToolRegistry,
  extraDenylist: readonly string[] = [],
): ToolDefinition[] {
  const denied = new Set<string>([...INTERNAL_TOOL_DENYLIST, ...extraDenylist]);
  return registry
    .getAll()
    .filter((tool) => tool.permissionLevel !== 'forbidden' && !denied.has(tool.name));
}
