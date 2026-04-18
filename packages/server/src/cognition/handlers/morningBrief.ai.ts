import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../../pii/proxy.js';

const SYSTEM_PROMPT = 'Ты — R2, персональный ассистент dim. Язык — русский.';
const MAX_TOKENS = 1024;

interface CallParams {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
  prompt: string;
  signal: AbortSignal;
}

export async function callMorningBriefAI(params: CallParams): Promise<string> {
  const { piiProxy, anthropic, prompt, signal } = params;
  const anonymized = await piiProxy.anonymize(prompt);
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: anonymized.text }],
    },
    { signal },
  );
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock) return '';
  return piiProxy.deanonymize(textBlock.text);
}
