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

export async function extractFacts(
  ollama: OllamaClient,
  params: {
    userMessage: string;
    assistantMessage: string;
    model: string;
  },
): Promise<ExtractedFact[]> {
  const prompt = `${EXTRACT_PROMPT_HEADER}

Діалог:
User: ${params.userMessage}
R2: ${params.assistantMessage}

Відповідь (JSON масив):`;

  let response;
  try {
    response = await ollama.chat({
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    console.warn('[memory] fact extraction failed:', err instanceof Error ? err.message : err);
    return [];
  }

  const text = response.text || '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
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
