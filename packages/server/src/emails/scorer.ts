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

function normalize(raw: unknown, uids: number[]): Array<{ uid: number; importance: number }> {
  const byUid = new Map<number, number>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item.uid === 'number' && typeof item.importance === 'number') {
        byUid.set(item.uid, clamp(item.importance));
      }
    }
  }
  return uids.map((uid) => ({ uid, importance: byUid.get(uid) ?? 3 }));
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
      const sub = await deps.piiProxy.anonymize(m.subject);
      const snip = await deps.piiProxy.anonymize(m.snippet);
      anonymized.push({ uid: m.uid, from: m.from, subject: sub.text, snippet: snip.text });
    }
    const prompt = buildPrompt(anonymized);

    let scored: Array<{ uid: number; importance: number }> | null = null;
    const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
    if (useOllama) {
      try {
        const raw = await callOllama(deps.ollama!, prompt, deps.signal);
        const parsed = extractJson(raw);
        scored = normalize(parsed, batch.map((m) => m.uid));
      } catch {
        scored = null;
      }
    }
    if (!scored) {
      try {
        const raw = await callClaude(deps.anthropic, prompt, deps.signal);
        const parsed = extractJson(raw);
        scored = normalize(parsed, batch.map((m) => m.uid));
      } catch {
        scored = batch.map((m) => ({ uid: m.uid, importance: 3 }));
      }
    }
    result.push(...scored);
  }
  return result;
}
