import { describe, it, expect, vi, afterEach } from 'vitest';
import { callMorningBriefAI } from '../../handlers/morningBrief.ai.js';
import type { PiiProxy } from '../../../pii/proxy.js';

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
});
