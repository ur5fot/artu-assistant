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
      // Route 'system' role messages through OllamaChatParams.system instead
      // of passing them through as chat turns. ollama.ts:toOllamaMessage casts
      // unknown roles to 'user'|'assistant', so a system turn left in the
      // messages array would silently become an assistant message and lose
      // its instructional weight. The Claude provider does the same extraction
      // — keeping the two halves of TextProvider symmetric.
      const systemContent = params.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const nonSystem: MessageParam[] = params.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      return ollama.chat({
        messages: nonSystem,
        system: systemContent || undefined,
        model: params.model,
      });
    },
  };
}

const CLAUDE_MAX_TOKENS = 1024;
// Anthropic SDK defaults to a 10-minute per-request timeout. Memory indexing
// runs through a serialized queue (see service.ts indexQueue), so one wedged
// upstream call would stall all subsequent turns for the full SDK window.
// Cap fact extraction at 30s — matches the user-perceptible "is memory stuck?"
// threshold and is well above typical Haiku latency for a 4 KB prompt.
const CLAUDE_TIMEOUT_MS = 30_000;

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

      const response = await anthropic.messages.create(
        {
          model: params.model,
          max_tokens: CLAUDE_MAX_TOKENS,
          // Fact extraction is a deterministic structured-JSON task; the Ollama
          // path forces temperature 0.2 for the same reason. Anthropic's default
          // is 1.0, which materially degrades JSON parse rate and fact recall.
          temperature: 0,
          system: systemContent || undefined,
          messages: nonSystem,
        },
        { timeout: CLAUDE_TIMEOUT_MS },
      );

      // Truncated JSON output silently breaks extractor's parser; flag it so
      // operators can raise the cap or shorten input instead of losing facts.
      if (response.stop_reason === 'max_tokens') {
        console.warn(
          `[memory] Claude text provider hit max_tokens (${CLAUDE_MAX_TOKENS}); output may be truncated`,
        );
      }

      const firstText = response.content.find((b) => b.type === 'text');
      return { text: firstText && 'text' in firstText ? firstText.text : '' };
    },
  };
}
