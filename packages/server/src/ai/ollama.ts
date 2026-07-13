import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaToolDef {
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

export interface OllamaChatParams {
  messages: MessageParam[];
  system?: string;
  signal?: AbortSignal;
  tools?: OllamaToolDef[];
  model?: string;
  format?: Record<string, unknown>;
  temperature?: number;
}

export interface OllamaChatResult {
  text: string;
  toolCalls?: OllamaToolCall[];
}

export interface OllamaClient {
  chat(params: OllamaChatParams): Promise<OllamaChatResult>;
}

interface OllamaMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

function toOllamaMessage(msg: MessageParam | { role: string; content: string; tool_calls?: OllamaToolCall[] }): OllamaMessage {
  // Tool result messages and assistant messages with tool_calls come from
  // the ollama-tool-loop and should be passed through directly.
  const anyMsg = msg as any;
  if (anyMsg.role === 'tool') {
    return {
      role: 'tool',
      content: typeof anyMsg.content === 'string' ? anyMsg.content : '',
      tool_name: typeof anyMsg.tool_name === 'string' ? anyMsg.tool_name : undefined,
    };
  }
  if (anyMsg.role === 'assistant' && anyMsg.tool_calls) {
    return { role: 'assistant', content: anyMsg.content ?? '', tool_calls: anyMsg.tool_calls };
  }

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
      const model = params.model ?? process.env.OLLAMA_MODEL ?? 'qwen3:1.7b';
      const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || (model.startsWith('qwen3') ? 30000 : 15000);
      const numCtxRaw = Number(process.env.OLLAMA_NUM_CTX);
      const numCtx = Number.isFinite(numCtxRaw) && numCtxRaw > 0 ? numCtxRaw : 8192;

      const ollamaMessages = params.messages.map(toOllamaMessage);
      if (params.system) {
        ollamaMessages.unshift({ role: 'system', content: params.system });
      }

      const body: Record<string, unknown> = {
        model,
        stream: false,
        messages: ollamaMessages,
        options: {
          temperature: params.temperature ?? 0.2,
          top_p: 0.9,
          // Ollama's default num_ctx (4096) silently truncates once the
          // system prompt + tool schemas + history exceed it — the model
          // "loses" tools without any error surfacing.
          num_ctx: numCtx,
        },
      };
      // qwen3 thinks by default, which adds seconds per turn on M1 and
      // compounds across tool-loop iterations. Other models may reject the
      // flag, so only send it where it applies.
      if (model.startsWith('qwen3')) {
        body.think = false;
      }
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
      }
      if (params.format) {
        body.format = params.format;
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

      if (process.env.OLLAMA_DEBUG === '1') {
        console.log('[ollama raw response]', JSON.stringify({
          model,
          has_tools: !!params.tools?.length,
          content: text,
          tool_calls: toolCalls,
        }, null, 2));
      }

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
