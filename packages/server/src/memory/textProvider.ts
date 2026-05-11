import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { OllamaClient } from '../ai/ollama.js';

export interface TextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TextProvider {
  chat(params: { messages: TextMessage[]; model: string }): Promise<{ text: string }>;
}

export function createOllamaTextProvider(ollama: OllamaClient): TextProvider {
  return {
    async chat(params) {
      return ollama.chat({
        messages: params.messages as MessageParam[],
        model: params.model,
      });
    },
  };
}

const CLAUDE_MAX_TOKENS = 1024;

export function createClaudeTextProvider(anthropic: Anthropic): TextProvider {
  return {
    async chat(params) {
      const systemContent = params.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');

      const nonSystem: MessageParam[] = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));

      const response = await anthropic.messages.create({
        model: params.model,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: systemContent || undefined,
        messages: nonSystem,
      });

      const firstText = response.content.find((b) => b.type === 'text');
      return { text: firstText && 'text' in firstText ? firstText.text : '' };
    },
  };
}
