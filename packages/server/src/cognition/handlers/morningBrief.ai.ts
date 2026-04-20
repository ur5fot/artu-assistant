import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { ToolDefinition } from '@r2/shared';
import type { PiiProxy } from '../../pii/proxy.js';
import type { OllamaClient } from '../../ai/ollama.js';
import { toClaudeTool } from '../../tools/base.js';
import { deanonDeep } from '../../ai/tool-helpers.js';

const SYSTEM_PROMPT = `Ты — R2, персональный ассистент dim. Язык ответа — ТОЛЬКО русский.

ВАЖНО: входные данные могут содержать украинские слова (имена, города, пункты календаря, таймзона). Переводи их на русский:
- Київ → Киев
- Дмитро → Дмитрий
- Обід → Обед
- Вечеря → Ужин
и аналогично для любых других украинских слов. Не копируй украинские слова в русский текст.`;
const MAX_TOKENS = 1024;
const MAX_TOOL_ITERATIONS = 5;

interface CallParams {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
  ollama?: OllamaClient | null;
  prompt: string;
  signal: AbortSignal;
  webSearchTool?: ToolDefinition | null;
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

function extractText(content: any[]): string {
  const textBlock = content.find((b) => b.type === 'text');
  return textBlock && textBlock.type === 'text' ? textBlock.text : '';
}

async function callClaude(
  anthropic: Anthropic,
  prompt: string,
  signal: AbortSignal,
  piiProxy: PiiProxy,
  webSearchTool: ToolDefinition | null | undefined,
): Promise<string> {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const tools = webSearchTool ? [toClaudeTool(webSearchTool)] : undefined;
  const messages: MessageParam[] = [{ role: 'user', content: prompt }];
  let lastText = '';
  let lastEndedWithToolUse = false;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (signal.aborted) return lastText;

    const msg = await anthropic.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        tools: tools as any,
      },
      { signal },
    );

    const content = msg.content as any[];
    lastText = extractText(content);

    if (msg.stop_reason !== 'tool_use') return lastText;
    lastEndedWithToolUse = true;

    const toolUse = content.find((b) => b.type === 'tool_use');
    if (!toolUse || !webSearchTool) return lastText;

    messages.push({ role: 'assistant', content: content as any });

    let resultText: string;
    let isError = false;
    try {
      if (toolUse.name !== webSearchTool.name) {
        resultText = `Unknown tool: ${toolUse.name}`;
        isError = true;
      } else {
        const rawArgs = (toolUse.input ?? {}) as Record<string, unknown>;
        const args = (await deanonDeep(rawArgs, piiProxy)) as Record<string, unknown>;
        const result = await webSearchTool.handler(args, { signal });
        if (result.success) {
          resultText = result.display?.content ?? 'No results';
        } else {
          resultText = result.error || 'Tool returned failure';
          isError = true;
        }
      }
    } catch (err) {
      resultText = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: resultText,
          is_error: isError,
        } as any,
      ],
    });
  }

  if (lastEndedWithToolUse && !signal.aborted) {
    console.warn('[morningBrief] hit max tool iterations, asking for final answer');
    const finalMsg = await anthropic.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          ...messages,
          { role: 'user', content: 'Хватит инструментов. Дай финальный ответ сейчас.' },
        ],
        tools: [],
      },
      { signal },
    );
    return extractText(finalMsg.content as any[]);
  }

  return lastText;
}

export async function callMorningBriefAI(params: CallParams): Promise<string> {
  const { piiProxy, anthropic, ollama, prompt, signal, webSearchTool } = params;
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
      text = await callClaude(anthropic, anonymized.text, signal, piiProxy, webSearchTool ?? null);
    }
  } else {
    text = await callClaude(anthropic, anonymized.text, signal, piiProxy, webSearchTool ?? null);
  }
  return text ? piiProxy.deanonymize(text) : '';
}
