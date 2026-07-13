import type Anthropic from '@anthropic-ai/sdk';

/** Shared shape for the tutor modules' Claude calls. `signal` is optional:
 *  cognition handlers thread `ctx.signal`; interaction flows own their
 *  lifecycle and pass none. */
export interface ClaudeCallDeps {
  anthropic: Anthropic;
  model: string;
  signal?: AbortSignal;
}

/** Call Claude with a system + user prompt, returning the first text block. */
export async function callClaude(
  deps: ClaudeCallDeps,
  system: string,
  userPrompt: string,
  maxTokens: number,
): Promise<string> {
  const msg = await deps.anthropic.messages.create(
    {
      model: deps.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    },
    deps.signal ? { signal: deps.signal } : {},
  );
  const block = (msg.content as Array<{ type: string; text?: string }>).find(
    (b) => b.type === 'text',
  );
  return block?.text ?? '';
}

/** Pull a JSON object out of an LLM reply, tolerating ```json fences and prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found');
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
