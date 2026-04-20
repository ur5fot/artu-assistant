import { describe, it, expect, vi, afterEach } from 'vitest';
import { callMorningBriefAI } from '../../handlers/morningBrief.ai.js';
import type { PiiProxy } from '../../../pii/proxy.js';
import type { ToolDefinition, ToolResult } from '@r2/shared';

function fakeWebSearchTool(handler: (params: Record<string, unknown>) => Promise<ToolResult>): ToolDefinition {
  return {
    name: 'web_search',
    description: 'search',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    handler,
  };
}

function makeToolUseResponse(toolName: string, input: Record<string, unknown>, id = 'tu_1') {
  return {
    id: 'msg_test',
    content: [{ type: 'tool_use', id, name: toolName, input }],
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function makeTextResponse(text: string) {
  return {
    id: 'msg_test',
    content: [{ type: 'text', text }],
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) {
      return { text: text.replace('dim', '[TOKEN_USER]'), entities: [] };
    },
    async deanonymize(text) {
      return text.replace('[TOKEN_USER]', 'dim');
    },
  };
}

function fakeAnthropic(responseText: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        id: 'msg_test',
        content: [{ type: 'text', text: responseText }],
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    },
  };
}

function fakeOllama(responseText: string) {
  return {
    chat: vi.fn(async () => ({ text: responseText })),
  };
}

describe('callMorningBriefAI', () => {
  const originalModel = process.env.CLAUDE_MODEL;
  const originalLocalMode = process.env.LOCAL_LLM_MODE;
  afterEach(() => {
    if (originalModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = originalModel;
    if (originalLocalMode === undefined) delete process.env.LOCAL_LLM_MODE;
    else process.env.LOCAL_LLM_MODE = originalLocalMode;
  });

  it('anonymizes prompt, calls anthropic, deanonymizes response', async () => {
    const anthropic = fakeAnthropic('Доброе утро, [TOKEN_USER]!');
    const piiProxy = fakeProxy();
    const result = await callMorningBriefAI({
      piiProxy,
      anthropic: anthropic as any,
      prompt: 'Привет dim',
      signal: new AbortController().signal,
    });
    expect(result).toBe('Доброе утро, dim!');
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    const call = (anthropic.messages.create.mock.calls as any[])[0][0];
    expect(call.messages[0].content).toContain('[TOKEN_USER]');
    expect(call.messages[0].content).not.toContain('dim');
  });

  it('uses CLAUDE_MODEL env var when set', async () => {
    process.env.CLAUDE_MODEL = 'claude-test-model';
    const anthropic = fakeAnthropic('ok');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    const call = (anthropic.messages.create.mock.calls as any[])[0][0];
    expect(call.model).toBe('claude-test-model');
  });

  it('falls back to claude-sonnet-4-6 when CLAUDE_MODEL unset', async () => {
    delete process.env.CLAUDE_MODEL;
    const anthropic = fakeAnthropic('ok');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    const call = (anthropic.messages.create.mock.calls as any[])[0][0];
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('returns empty string when response has no text block', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({ content: [], role: 'assistant' })),
      },
    };
    const result = await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(result).toBe('');
  });

  it('returns empty string when content has only non-text blocks', async () => {
    const anthropic = {
      messages: {
        create: vi.fn(async () => ({
          content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
          role: 'assistant',
        })),
      },
    };
    const result = await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(result).toBe('');
  });

  it('passes signal to anthropic.messages.create', async () => {
    const anthropic = fakeAnthropic('ok');
    const controller = new AbortController();
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: controller.signal,
    });
    const opts = (anthropic.messages.create.mock.calls as any[])[0][1];
    expect(opts?.signal).toBe(controller.signal);
  });

  it('uses ollama when LOCAL_LLM_MODE=enabled and ollama provided', async () => {
    process.env.LOCAL_LLM_MODE = 'enabled';
    const anthropic = fakeAnthropic('from-claude');
    const ollama = fakeOllama('Доброе утро от локалки, [TOKEN_USER]!');
    const result = await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      ollama: ollama as any,
      prompt: 'Привет dim',
      signal: new AbortController().signal,
    });
    expect(result).toBe('Доброе утро от локалки, dim!');
    expect(ollama.chat).toHaveBeenCalledOnce();
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('defaults to LOCAL_LLM_MODE=enabled when env var unset', async () => {
    delete process.env.LOCAL_LLM_MODE;
    const anthropic = fakeAnthropic('from-claude');
    const ollama = fakeOllama('from-ollama');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      ollama: ollama as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(ollama.chat).toHaveBeenCalledOnce();
    expect(anthropic.messages.create).not.toHaveBeenCalled();
  });

  it('uses Claude when LOCAL_LLM_MODE=disabled even if ollama provided', async () => {
    process.env.LOCAL_LLM_MODE = 'disabled';
    const anthropic = fakeAnthropic('from-claude');
    const ollama = fakeOllama('from-ollama');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      ollama: ollama as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it('uses Claude when ollama is null regardless of LOCAL_LLM_MODE', async () => {
    process.env.LOCAL_LLM_MODE = 'enabled';
    const anthropic = fakeAnthropic('from-claude');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      ollama: null,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
  });

  it('system prompt instructs to translate Ukrainian words to Russian', async () => {
    const anthropic = fakeAnthropic('ok');
    await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    const call = (anthropic.messages.create.mock.calls as any[])[0][0];
    expect(call.system).toContain('ТОЛЬКО русский');
    expect(call.system).toContain('Київ → Киев');
    expect(call.system).toContain('Не копируй украинские слова');
  });

  it('falls back to Claude when ollama throws', async () => {
    process.env.LOCAL_LLM_MODE = 'enabled';
    const anthropic = fakeAnthropic('from-claude');
    const ollama = { chat: vi.fn(async () => { throw new Error('ollama down'); }) };
    const result = await callMorningBriefAI({
      piiProxy: fakeProxy(),
      anthropic: anthropic as any,
      ollama: ollama as any,
      prompt: 'x',
      signal: new AbortController().signal,
    });
    expect(result).toBe('from-claude');
    expect(ollama.chat).toHaveBeenCalledOnce();
    expect(anthropic.messages.create).toHaveBeenCalledOnce();
  });

  describe('web_search tool loop', () => {
    it('happy path: Claude calls web_search, uses result in final text', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      const handler = vi.fn(async () => ({
        success: true,
        data: [],
        display: { type: 'text' as const, content: 'Погода в Киеве: +15' },
      }));
      const tool = fakeWebSearchTool(handler as any);
      const create = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('web_search', { query: 'погода Киев' }))
        .mockResolvedValueOnce(makeTextResponse('Доброе утро! +15 в Киеве.'));
      const anthropic = { messages: { create } };
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'brief',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(result).toBe('Доброе утро! +15 в Киеве.');
      expect(handler).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledTimes(2);
      const secondCall = create.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      expect(toolResultMsg).toBeDefined();
      expect(toolResultMsg.content[0].content).toContain('Погода в Киеве');
    });

    it('no-tool path: Claude responds with text immediately', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      const handler = vi.fn();
      const tool = fakeWebSearchTool(handler as any);
      const create = vi.fn().mockResolvedValueOnce(makeTextResponse('Доброе утро!'));
      const anthropic = { messages: { create } };
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(result).toBe('Доброе утро!');
      expect(handler).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();
      const firstCall = create.mock.calls[0][0];
      expect(firstCall.tools).toBeDefined();
      expect(firstCall.tools.length).toBe(1);
      expect(firstCall.tools[0].name).toBe('web_search');
    });

    it('tool error: returns brief text despite handler rejection', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      const handler = vi.fn(async () => { throw new Error('searxng down'); });
      const tool = fakeWebSearchTool(handler as any);
      const create = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('web_search', { query: 'погода' }))
        .mockResolvedValueOnce(makeTextResponse('Доброе утро, без погоды.'));
      const anthropic = { messages: { create } };
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(result).toBe('Доброе утро, без погоды.');
      const secondCall = create.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      expect(toolResultMsg.content[0].is_error).toBe(true);
      expect(toolResultMsg.content[0].content).toContain('searxng down');
    });

    it('tool success=false: marks tool_result as error and continues', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      const handler = vi.fn(async () => ({ success: false as const, error: 'network fail' }));
      const tool = fakeWebSearchTool(handler as any);
      const create = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('web_search', { query: 'погода' }))
        .mockResolvedValueOnce(makeTextResponse('Итог без погоды.'));
      const anthropic = { messages: { create } };
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(result).toBe('Итог без погоды.');
      const secondCall = create.mock.calls[1][0];
      const toolResultMsg = secondCall.messages.find(
        (m: any) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
      );
      expect(toolResultMsg.content[0].is_error).toBe(true);
      expect(toolResultMsg.content[0].content).toContain('network fail');
    });

    it('max iterations: forces final answer with tools disabled after 5 tool_use iterations', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      const handler = vi.fn(async () => ({
        success: true as const,
        data: [],
        display: { type: 'text' as const, content: 'ok' },
      }));
      const tool = fakeWebSearchTool(handler as any);
      const create = vi
        .fn()
        .mockImplementation(async (req: any) => {
          if (Array.isArray(req.tools) && req.tools.length === 0) {
            return makeTextResponse('Финальный ответ без инструментов.');
          }
          return makeToolUseResponse('web_search', { query: 'x' });
        });
      const anthropic = { messages: { create } };
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(create).toHaveBeenCalledTimes(6);
      expect(handler).toHaveBeenCalledTimes(5);
      expect(result).toBe('Финальный ответ без инструментов.');
      const finalCall = create.mock.calls[5][0];
      expect(finalCall.tools).toEqual([]);
    });

    it('ollama path: tool loop is NOT used when LOCAL_LLM_MODE=enabled', async () => {
      process.env.LOCAL_LLM_MODE = 'enabled';
      const handler = vi.fn();
      const tool = fakeWebSearchTool(handler as any);
      const anthropic = fakeAnthropic('unused');
      const ollama = fakeOllama('Доброе утро от локалки');
      const result = await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        ollama: ollama as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(result).toBe('Доброе утро от локалки');
      expect(handler).not.toHaveBeenCalled();
      expect(anthropic.messages.create).not.toHaveBeenCalled();
      expect(ollama.chat).toHaveBeenCalledOnce();
    });

    it('deanonymizes tool args before calling handler', async () => {
      process.env.LOCAL_LLM_MODE = 'disabled';
      let receivedQuery = '';
      const handler = vi.fn(async (params: Record<string, unknown>) => {
        receivedQuery = params.query as string;
        return {
          success: true as const,
          data: [],
          display: { type: 'text' as const, content: 'ok' },
        };
      });
      const tool = fakeWebSearchTool(handler as any);
      const create = vi.fn()
        .mockResolvedValueOnce(makeToolUseResponse('web_search', { query: 'погода [TOKEN_USER]' }))
        .mockResolvedValueOnce(makeTextResponse('done'));
      const anthropic = { messages: { create } };
      await callMorningBriefAI({
        piiProxy: fakeProxy(),
        anthropic: anthropic as any,
        prompt: 'x',
        signal: new AbortController().signal,
        webSearchTool: tool,
      });
      expect(receivedQuery).toBe('погода dim');
    });
  });
});
