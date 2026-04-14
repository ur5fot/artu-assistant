import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { getSystemPrompt } from './prompts.js';

// Reading `process.env.*` at request time (not at module load) is critical:
// in ESM, all imports run before any top-level statements in the importing
// module, so `dotenv.config()` in index.ts has NOT yet executed when this
// module is first evaluated. Module-level constants would always see the
// fallbacks. Resolving inside the closure ensures we pick up the loaded .env.
function resolveClaudeConfig() {
  return {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS) || 16384,
    thinkingBudget: Number(process.env.CLAUDE_THINKING_BUDGET) || 10240,
  };
}

interface SendMessageParams {
  messages: MessageParam[];
  tools: Tool[];
  signal?: AbortSignal;
}

export interface ClaudeClient {
  sendMessage(params: SendMessageParams): Promise<Anthropic.Message>;
  anthropic: Anthropic;
}

export function createClaudeClient(): ClaudeClient {
  const anthropic = new Anthropic();

  async function sendMessage(params: SendMessageParams): Promise<Anthropic.Message> {
    const { model, maxTokens, thinkingBudget } = resolveClaudeConfig();
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: getSystemPrompt(),
      messages: params.messages,
      thinking: {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      },
    };

    if (params.tools.length > 0) {
      requestParams.tools = params.tools;
    }

    try {
      return await anthropic.messages.create(requestParams, { signal: params.signal });
    } catch (error: unknown) {
      const status = (error as { status?: number }).status;
      if (status && status >= 500 && !params.signal?.aborted) {
        // Retry once on 5xx
        return await anthropic.messages.create(requestParams, { signal: params.signal });
      }
      throw error;
    }
  }

  return { sendMessage, anthropic };
}
