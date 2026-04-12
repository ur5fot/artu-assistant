import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OllamaChatParams {
  messages: MessageParam[];
  system?: string;
  signal?: AbortSignal;
  tools?: OllamaToolDef[];
}

interface OllamaChatResult {
  text: string;
  toolCalls?: OllamaToolCall[];
}

export interface OllamaClient {
  chat(params: OllamaChatParams): Promise<OllamaChatResult>;
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

function toOllamaMessage(msg: MessageParam): OllamaMessage {
  let content: string;
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Refuse non-text blocks (tool_use / tool_result / image) — silently
    // dropping them would feed Ollama an empty or corrupted turn. The
    // router's catch will fall back to Claude, which actually understands
    // these blocks.
    const hasNonText = msg.content.some((block: any) => block?.type !== 'text');
    if (hasNonText) {
      throw new Error('Ollama cannot handle non-text content blocks');
    }
    content = msg.content
      .map((block: any) => (typeof block.text === 'string' ? block.text : ''))
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

      const body: Record<string, unknown> = {
        model,
        stream: false,
        messages: ollamaMessages,
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
      }

      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = params.signal
        ? AbortSignal.any([params.signal, timeoutSignal])
        : timeoutSignal;

      const res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        // Intentionally do not include the response body — it can echo the
        // (anonymized) prompt or upstream internals, and this error is
        // console.warn'd by the router. Cancel the body so undici releases
        // the socket instead of waiting for GC.
        await res.body?.cancel().catch(() => {});
        throw new Error(`Ollama error ${res.status}`);
      }

      let data: any;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error(`Ollama returned invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`);
      }

      const text = data?.message?.content ?? '';
      const toolCalls: OllamaToolCall[] | undefined = data?.message?.tool_calls;

      return { text, toolCalls: toolCalls?.length ? toolCalls : undefined };
    },
  };
}

export function toOllamaToolDef(tool: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }): OllamaToolDef {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
