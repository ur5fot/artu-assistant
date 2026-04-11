import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

interface OllamaChatParams {
  messages: MessageParam[];
  system?: string;
  signal?: AbortSignal;
}

interface OllamaChatResult {
  text: string;
}

export interface OllamaClient {
  chat(params: OllamaChatParams): Promise<OllamaChatResult>;
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

function toOllamaMessage(msg: MessageParam): OllamaMessage {
  let content: string;
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  } else {
    content = '';
  }
  return {
    role: msg.role as 'user' | 'assistant',
    content,
  };
}

export function createOllamaClient(): OllamaClient {
  return {
    async chat(params: OllamaChatParams): Promise<OllamaChatResult> {
      const url = process.env.OLLAMA_URL || 'http://localhost:11434';
      const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
      const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 15000;

      const ollamaMessages = params.messages.map(toOllamaMessage);
      if (params.system) {
        ollamaMessages.unshift({ role: 'system', content: params.system });
      }

      const body = JSON.stringify({
        model,
        stream: false,
        messages: ollamaMessages,
      });

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = params.signal
        ? AbortSignal.any([params.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error(`Ollama returned invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
      }

      const text = data?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('Ollama response missing message.content');
      }

      return { text };
    },
  };
}
