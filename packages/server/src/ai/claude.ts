import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages';
import { SYSTEM_PROMPT } from './prompts.js';

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
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: params.messages,
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
