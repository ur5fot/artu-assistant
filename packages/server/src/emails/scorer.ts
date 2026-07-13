import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from '../ai/ollama.js';

export interface ScorerDeps {
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  anthropic: Anthropic;
  signal: AbortSignal;
}

interface MsgInput {
  uid: number;
  from: string;
  subject: string;
  snippet: string;
}

const SCORE_SYSTEM = `Ты фильтр входящей почты. Для каждого письма оцени importance по шкале 1-5:
1 — newsletter/promo/bulk (удаляется не читая).
2 — инфо без действий (order confirmation, system notice).
3 — стоит заметить, не срочно.
4 — требует ответа/действия (человек, приглашение, счёт, документ).
5 — срочное/критичное (банк, юридика, здоровье, deadline сегодня).
Отвечай ТОЛЬКО JSON массивом [{"uid":<int>,"importance":<1..5>}, ...]. Без текста вокруг.`;

const SCORE_FORMAT: Record<string, unknown> = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      uid: { type: 'integer' },
      importance: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['uid', 'importance'],
    additionalProperties: false,
  },
};

const MAX_BATCH = 10;
const SNIPPET_CHARS = 300;

function buildPrompt(msgs: MsgInput[]): string {
  const payload = msgs.map((m) => ({
    uid: m.uid,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet.slice(0, SNIPPET_CHARS),
  }));
  return `Оцени важность писем:\n\n${JSON.stringify(payload, null, 2)}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart === -1 || bracketEnd === -1 || bracketEnd <= bracketStart) {
    throw new Error('no JSON array found');
  }
  return JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

// Returns null when the LLM reply does not cover every requested uid — the
// caller treats that the same as an unparseable response (falls back to the
// other provider, or surfaces an error). Defaulting missing uids to 3 would
// silently drop them below the cutoff while the poller advances last_seen_uid,
// permanently losing those messages from view.
function normalize(
  raw: unknown,
  uids: number[],
): Array<{ uid: number; importance: number }> | null {
  if (!Array.isArray(raw)) return null;
  const requestedUids = new Set(uids);
  const byUid = new Map<number, number>();
  for (const item of raw) {
    if (item && typeof item.uid === 'number' && typeof item.importance === 'number') {
      if (!requestedUids.has(item.uid)) return null;
      byUid.set(item.uid, clamp(item.importance));
    }
  }
  for (const uid of uids) {
    if (!byUid.has(uid)) return null;
  }
  return uids.map((uid) => ({ uid, importance: byUid.get(uid)! }));
}

async function callOllama(
  ollama: OllamaClient,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const r = await ollama.chat({
    messages: [{ role: 'user', content: userPrompt }],
    system: SCORE_SYSTEM,
    signal,
    format: SCORE_FORMAT,
    temperature: 0,
  });
  return r.text;
}

async function callClaude(
  anthropic: Anthropic,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: 512,
      system: SCORE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { signal },
  );
  const block = (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return block?.text ?? '';
}

export async function scoreBatch(
  msgs: MsgInput[],
  deps: ScorerDeps,
): Promise<Array<{ uid: number; importance: number }>> {
  if (msgs.length === 0) return [];
  const batches: MsgInput[][] = [];
  for (let i = 0; i < msgs.length; i += MAX_BATCH) {
    batches.push(msgs.slice(i, i + MAX_BATCH));
  }

  const result: Array<{ uid: number; importance: number }> = [];
  for (const batch of batches) {
    const anonymized: MsgInput[] = [];
    for (const m of batch) {
      const sender = await deps.piiProxy.anonymize(stripAddress(m.from));
      const sub = await deps.piiProxy.anonymize(m.subject);
      const snip = await deps.piiProxy.anonymize(m.snippet);
      anonymized.push({ uid: m.uid, from: sender.text, subject: sub.text, snippet: snip.text });
    }
    const prompt = buildPrompt(anonymized);

    let scored: Array<{ uid: number; importance: number }> | null = null;
    const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
    if (useOllama) {
      try {
        const raw = await callOllama(deps.ollama!, prompt, deps.signal);
        const parsed = JSON.parse(raw.trim());
        scored = normalize(parsed, batch.map((m) => m.uid));
        if (!scored) {
          console.warn('[emails.scorer] Ollama reply did not cover every uid, falling back to Claude');
        }
      } catch (err) {
        console.warn(
          '[emails.scorer] Ollama call failed, falling back to Claude:',
          err instanceof Error ? err.message : err,
        );
        scored = null;
      }
    }
    if (!scored) {
      const raw = await callClaude(deps.anthropic, prompt, deps.signal);
      const parsed = extractJson(raw);
      scored = normalize(parsed, batch.map((m) => m.uid));
      if (!scored) {
        // Both scorers failed — surface this instead of silently dropping
        // messages. The poller's per-account catch turns the throw into
        // setAccountError, and last_seen_uid is NOT advanced, so the batch
        // is retried on the next tick.
        throw new Error('scorer reply did not cover every uid (both Ollama and Claude)');
      }
    }
    result.push(...scored);
  }
  return result;
}

function stripAddress(from: string): string {
  // "Alice <alice@x.com>" → "Alice"; "<a@b>" / "a@b" → "a@b" (piiProxy handles the address).
  const m = from.match(/^(.+?)\s*<[^>]+>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  return from;
}
