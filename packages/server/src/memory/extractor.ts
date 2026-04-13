import type { OllamaClient } from '../ai/ollama.js';

export interface ExtractedFact {
  key: string;
  value: string;
}

const EXTRACT_PROMPT_HEADER = `Витягни стійкі факти про юзера з наступного діалогу у форматі JSON масиву:
[{"key": "user.location", "value": "Одеса"}, ...]

Використовуй канонічні ключі з цього списку коли можливо:
- user.location — де юзер живе
- user.phone — номер телефону
- user.email — email
- user.preferences.<topic> — уподобання (food, music, work, ...)
- user.name — як юзера звати
- task.deadline.<project> — дедлайни
- project.<name>.status — стан проектів

Правила:
- Витягуй ТІЛЬКИ стійкі факти про юзера, не тимчасові стани
- Не вигадуй факти яких немає в діалозі
- Якщо фактів немає — поверни []

Відповідь має бути ТІЛЬКИ JSON масив, без коментарів.`;

// Walks the LLM response with a small state machine to return the first
// balanced JSON array. A naive `/\[[\s\S]*\]/` is greedy and breaks when the
// model adds chatter containing stray brackets (e.g. "Here: [{...}]. See [note].").
function extractJsonArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export async function extractFacts(
  ollama: OllamaClient,
  params: {
    userMessage: string;
    assistantMessage: string;
    model: string;
  },
): Promise<ExtractedFact[]> {
  const MAX = 4000;
  const userText = params.userMessage.length > MAX ? params.userMessage.slice(0, MAX) : params.userMessage;
  const assistantText = params.assistantMessage.length > MAX ? params.assistantMessage.slice(0, MAX) : params.assistantMessage;
  const prompt = `${EXTRACT_PROMPT_HEADER}

Діалог:
User: ${userText}
R2: ${assistantText}

Відповідь (JSON масив):`;

  let response;
  try {
    response = await ollama.chat({
      messages: [{ role: 'user', content: prompt }],
      model: params.model,
    });
  } catch (err) {
    console.warn('[memory] fact extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }

  const text = response.text || '';
  const arrayText = extractJsonArray(text);
  if (!arrayText) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as any).key === 'string' &&
      typeof (item as any).value === 'string' &&
      (item as any).key.length > 0 &&
      (item as any).value.length > 0
    ) {
      facts.push({ key: (item as any).key, value: (item as any).value });
    }
  }
  return facts;
}
