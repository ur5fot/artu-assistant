import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from '../ai/ollama.js';

export interface GistDeps {
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  anthropic: Anthropic;
  signal: AbortSignal;
}

export interface GistInput {
  uid: number;
  from: string;
  subject: string;
  body: string;
}

const GIST_SYSTEM = `Ты помощник, который делает короткую суть входящего письма НА РУССКОМ ЯЗЫКЕ.
Для каждого письма напиши 2-3 предложения: о чём письмо и что от получателя ожидается (какое действие/ответ, если есть).
Пиши по-русски, даже если письмо на другом языке. Не выдумывай фактов, которых нет в письме.
Сохраняй плейсхолдеры вида <TYPE:xxxxxxxx> без изменений, если они встречаются.
Отвечай ТОЛЬКО JSON массивом [{"uid":<int>,"gist":"<суть на русском>"}, ...]. Без текста вокруг.`;

const MAX_BATCH = 10;
const BODY_CHARS = 1200;

function buildPrompt(msgs: GistInput[]): string {
  const payload = msgs.map((m) => ({
    uid: m.uid,
    from: m.from,
    subject: m.subject,
    body: m.body.slice(0, BODY_CHARS),
  }));
  return `Сделай суть для писем:\n\n${JSON.stringify(payload, null, 2)}`;
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

// Best-effort: collects whatever valid {uid, gist} pairs the reply covers.
// Unlike the scorer, a missing uid is fine — it simply won't appear in the map
// and the caller shows the raw snippet instead. Returns null only when the
// reply is not an array (unparseable), so the caller can fall back to the other
// provider before giving up.
function normalize(raw: unknown): Map<number, string> | null {
  if (!Array.isArray(raw)) return null;
  const byUid = new Map<number, string>();
  for (const item of raw) {
    if (
      item &&
      typeof item.uid === 'number' &&
      typeof item.gist === 'string' &&
      item.gist.trim().length > 0
    ) {
      byUid.set(item.uid, item.gist.trim());
    }
  }
  return byUid;
}

async function callOllama(
  ollama: OllamaClient,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const r = await ollama.chat({
    messages: [{ role: 'user', content: userPrompt }],
    system: GIST_SYSTEM,
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
      max_tokens: 1024,
      system: GIST_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { signal },
  );
  const block = (msg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  return block?.text ?? '';
}

function stripAddress(from: string): string {
  // "Alice <alice@x.com>" → "Alice"; "<a@b>" / "a@b" → "a@b" (piiProxy handles the address).
  const m = from.match(/^(.+?)\s*<[^>]+>\s*$/);
  if (m && m[1].trim()) return m[1].trim();
  return from;
}

// Summarizes a batch of emails into short Russian gists. Best-effort: any
// failure (both providers down, unparseable replies) yields an empty map for
// that batch and is logged, never thrown — the importance path already ingested
// these messages and gist is purely additive.
export async function summarizeGists(
  msgs: GistInput[],
  deps: GistDeps,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (msgs.length === 0) return out;

  const batches: GistInput[][] = [];
  for (let i = 0; i < msgs.length; i += MAX_BATCH) {
    batches.push(msgs.slice(i, i + MAX_BATCH));
  }

  for (const batch of batches) {
    try {
      const anonymized: GistInput[] = [];
      for (const m of batch) {
        const sender = await deps.piiProxy.anonymize(stripAddress(m.from));
        const sub = await deps.piiProxy.anonymize(m.subject);
        const body = await deps.piiProxy.anonymize(m.body);
        anonymized.push({ uid: m.uid, from: sender.text, subject: sub.text, body: body.text });
      }
      const prompt = buildPrompt(anonymized);

      let parsed: Map<number, string> | null = null;
      const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
      if (useOllama) {
        try {
          const raw = await callOllama(deps.ollama!, prompt, deps.signal);
          parsed = normalize(extractJson(raw));
        } catch (err) {
          console.warn(
            '[emails.gist] Ollama call failed, falling back to Claude:',
            err instanceof Error ? err.message : err,
          );
          parsed = null;
        }
      }
      if (!parsed || parsed.size === 0) {
        const raw = await callClaude(deps.anthropic, prompt, deps.signal);
        parsed = normalize(extractJson(raw));
      }

      if (parsed) {
        for (const [uid, gist] of parsed) {
          const restored = await deps.piiProxy.deanonymize(gist);
          out.set(uid, restored);
        }
      }
    } catch (err) {
      console.warn(
        '[emails.gist] batch summarization failed, skipping gists for batch:',
        err instanceof Error ? err.message : err,
      );
      // best-effort: leave these uids out of the map, continue next batch
    }
  }

  return out;
}
