import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../../pii/proxy.js';
import type { OllamaClient } from '../../ai/ollama.js';

const SYSTEM_PROMPT = 'Ты — R2, персональный ассистент dim. Язык — русский.';
const MAX_TOKENS = 1024;

interface CallParams {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
  ollama?: OllamaClient | null;
  prompt: string;
  signal: AbortSignal;
}

function useLocalLlm(ollama: OllamaClient | null | undefined): ollama is OllamaClient {
  if (!ollama) return false;
  return (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
}

async function callOllama(
  ollama: OllamaClient,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await ollama.chat({
    messages: [{ role: 'user', content: prompt }],
    system: SYSTEM_PROMPT,
    signal,
  });
  return result.text;
}

async function callClaude(
  anthropic: Anthropic,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal },
  );
  const textBlock = msg.content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

export async function callMorningBriefAI(params: CallParams): Promise<string> {
  const { piiProxy, anthropic, ollama, prompt, signal } = params;
  const anonymized = await piiProxy.anonymize(prompt);
  let text: string;
  if (useLocalLlm(ollama)) {
    try {
      text = await callOllama(ollama, anonymized.text, signal);
    } catch (err) {
      console.warn(
        '[morningBrief] ollama failed, falling back to claude:',
        err instanceof Error ? err.message : err,
      );
      text = await callClaude(anthropic, anonymized.text, signal);
    }
  } else {
    text = await callClaude(anthropic, anonymized.text, signal);
  }
  return text ? piiProxy.deanonymize(text) : '';
}
