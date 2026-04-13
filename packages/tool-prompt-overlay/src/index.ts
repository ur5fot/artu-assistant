import type { ToolDefinition, ToolResult } from '@r2/shared';
import {
  getOverlay as defaultGetOverlay,
  setOverlay as defaultSetOverlay,
  clearOverlay as defaultClearOverlay,
  type OverlayModel,
} from '@r2/server/db.js';

export interface PromptOverlayDeps {
  getOverlay?: (model: OverlayModel) => string | null;
  setOverlay?: (model: OverlayModel, text: string) => void;
  clearOverlay?: (model: OverlayModel) => void;
}

interface Config {
  toolName: string;
  model: OverlayModel;
  commandName: string;
  commandDescription: string;
  label: string;
}

const CONFIGS: Config[] = [
  {
    toolName: 'prompt_overlay_claude',
    model: 'claude',
    commandName: 'клод-промпт',
    commandDescription: 'Керування надстройкою системного промпту Claude',
    label: 'Claude',
  },
  {
    toolName: 'prompt_overlay_ollama',
    model: 'ollama',
    commandName: 'лама-промпт',
    commandDescription: 'Керування надстройкою системного промпту Ollama',
    label: 'Ollama',
  },
];

function buildTool(cfg: Config, deps: Required<PromptOverlayDeps>): ToolDefinition {
  return {
    name: cfg.toolName,
    description: `Manage the user-editable prompt overlay appended to the ${cfg.label} system prompt. Use to set, view, or clear extra instructions (e.g. "be concise", "answer in English").`,
    permissionLevel: 'confirm',
    provider: 'all',
    command: {
      name: cfg.commandName,
      description: cfg.commandDescription,
      params: [{ name: 'text', required: false, description: 'Текст надстройки (або --показати / --скинути)' }],
      flags: [
        { token: '--показати', param: 'show', description: 'Показати поточний overlay' },
        { token: '--скинути', param: 'reset', description: 'Скинути overlay' },
      ],
    },
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Overlay text to save' },
        show: { type: 'boolean', description: 'Show current overlay instead of changing it' },
        reset: { type: 'boolean', description: 'Clear the overlay' },
      },
      required: [],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const show = params.show === true;
      const reset = params.reset === true;
      const rawText = typeof params.text === 'string' ? params.text.trim() : '';
      const hasText = rawText.length > 0;

      if (show && reset) {
        return { success: false, error: 'не можна поєднувати --показати і --скинути' };
      }
      if (show && hasText) {
        return { success: false, error: 'не можна поєднувати --показати з текстом' };
      }
      if (reset && hasText) {
        return { success: false, error: 'не можна поєднувати --скинути з текстом' };
      }

      try {
        if (show) {
          const current = deps.getOverlay(cfg.model);
          const content = current && current.trim().length > 0 ? current : 'порожньо';
          return {
            success: true,
            data: { model: cfg.model, overlay: current },
            display: { type: 'text', content },
          };
        }

        if (reset) {
          deps.clearOverlay(cfg.model);
          return {
            success: true,
            data: { model: cfg.model, cleared: true },
            display: { type: 'text', content: 'скинуто' },
          };
        }

        if (hasText) {
          deps.setOverlay(cfg.model, rawText);
          return {
            success: true,
            data: { model: cfg.model, saved: true },
            display: { type: 'text', content: 'збережено' },
          };
        }

        return {
          success: false,
          error: `usage: /${cfg.commandName} <текст> | /${cfg.commandName} --показати | /${cfg.commandName} --скинути`,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'prompt overlay tool failed',
        };
      }
    },
  };
}

export function createTool(deps: PromptOverlayDeps = {}): ToolDefinition[] {
  const resolved: Required<PromptOverlayDeps> = {
    getOverlay: deps.getOverlay ?? defaultGetOverlay,
    setOverlay: deps.setOverlay ?? defaultSetOverlay,
    clearOverlay: deps.clearOverlay ?? defaultClearOverlay,
  };
  return CONFIGS.map((cfg) => buildTool(cfg, resolved));
}

export default createTool;
