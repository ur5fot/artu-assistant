import type { OllamaClient } from '../ai/ollama.js';

export interface ExtractedFact {
  key: string;
  value: string;
  importance: number;
}

// Word-boundary match on cues that the user wants a fact pinned. Hit => bump
// importance to IMPORTANT_BOOST_VALUE so decay can't sink it. Cyrillic needs
// explicit boundaries since \b doesn't behave for non-ASCII.
const IMPORTANCE_KEYWORD_RE =
  /(?:^|[^\p{L}\p{N}_])(важливо|запам['’ʼ]?ятай|запомни|не\s+забудь|don['’]?t\s+forget|important)(?=$|[^\p{L}\p{N}_])/iu;

export const IMPORTANT_BOOST_VALUE = 10;

export function hasImportanceKeyword(text: string): boolean {
  return IMPORTANCE_KEYWORD_RE.test(text);
}

const EXTRACT_PROMPT_HEADER = `Витягни стійкі факти про юзера з наступного діалогу у форматі JSON масиву:
[{"key": "user.location", "value": "Одеса"}, ...]

ФОРМАТ КЛЮЧА: \`subject.attribute\` (або \`subject.attribute.subattr\`).
- subject — одне з: \`user\`, \`project\`, \`assistant\`, \`task\`
- attribute — snake_case, lowercase, тільки [a-z0-9_]
- завжди має містити крапку

Канонічні ключі з цього списку — коли можливо:
- user.location — де юзер живе
- user.phone — номер телефону
- user.email — email
- user.name — як юзера звати
- user.preferences.<topic> — уподобання (food, music, work, ...)
- user.wife, user.family.<member> — родина
- task.deadline.<project> — дедлайни
- project.<name>.status — стан проектів

Правила:
- Витягуй ТІЛЬКИ стійкі факти про юзера, не тимчасові стани
- Не вигадуй факти яких немає в діалозі
- Ключ — ЗАВЖДИ \`subject.attribute\`, lowercase, snake_case
- Якщо фактів немає — поверни []

Відповідь має бути ТІЛЬКИ JSON масив, без коментарів.`;

// Normalizes LLM-emitted keys into canonical `subject.attribute` form so supersede
// detection collapses drifted variants. Lowercase + spaces→_ + default `user.`
// prefix when the model forgets the subject namespace.
export function normalizeKey(raw: string): string {
  let k = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (!k.includes('.')) k = `user.${k}`;
  return k;
}

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

  const boost = hasImportanceKeyword(params.userMessage);

  // Memory-poisoning guard: facts get prefixed into future LLM prompts, so a
  // crafted user message could try to smuggle instructions through fact.value.
  // Constrain key to a strict lowercase charset (canonical schema), cap value
  // length, and strip control characters that could break out of our memory
  // block. Intentionally NOT case-insensitive — `User.Location` and
  // `user.location` must collapse to the same canonical key so supersede
  // detection works, so we reject mixed-case keys outright.
  const KEY_RE = /^[a-z][a-z0-9_.]{0,63}$/;
  const VALUE_MAX = 500;
  const facts: ExtractedFact[] = [];
  for (const item of parsed) {
    if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as any).key === 'string' &&
      typeof (item as any).value === 'string'
    ) {
      const key = normalizeKey((item as any).key as string);
      let value = (item as any).value as string;
      if (!KEY_RE.test(key)) continue;
      value = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (!value) continue;
      if (value.length > VALUE_MAX) value = value.slice(0, VALUE_MAX);
      facts.push({ key, value, importance: boost ? IMPORTANT_BOOST_VALUE : 1 });
    }
  }
  return facts;
}
