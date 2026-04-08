import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { SYSTEM_PROMPT } from './prompts.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = Number(process.env.CLAUDE_MAX_TOKENS) || 16384;
const THINKING_BUDGET = Number(process.env.CLAUDE_THINKING_BUDGET) || 10240;

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
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: params.messages,
      thinking: {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET,
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
