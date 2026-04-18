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

describe('callMorningBriefAI', () => {
  const originalModel = process.env.CLAUDE_MODEL;
  afterEach(() => {
    if (originalModel === undefined) delete process.env.CLAUDE_MODEL;
    else process.env.CLAUDE_MODEL = originalModel;
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
});
