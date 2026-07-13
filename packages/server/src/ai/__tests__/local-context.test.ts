import { describe, expect, it } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { buildLocalContext, type LocalContextConfig } from '../local-context.js';

const config: LocalContextConfig = {
  numCtx: 100,
  outputReserveTokens: 20,
  charsPerToken: 2,
  memoryMaxChars: 30,
  topicMaxChars: 30,
};

describe('buildLocalContext', () => {
  it('keeps the newest complete messages within a separate token budget', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'old '.repeat(20) },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current question' },
    ];
    const result = buildLocalContext({ messages, system: 'short system', config });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.messages[0].role).toBe('user');
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(result.estimatedPromptTokens).toBeLessThanOrEqual(config.numCtx - config.outputReserveTokens);
  });

  it('adds bounded memory and topic blocks as data', () => {
    const result = buildLocalContext({
      messages: [{ role: 'user', content: 'hi' }],
      system: 'system',
      memoryPrefix: 'm'.repeat(100),
      topicSummaryPrefix: 'topic',
      config: { ...config, numCtx: 200 },
    });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.system).toContain('<retrieved_memory>');
    expect(result.system).toContain('[context truncated]');
    expect(result.system).toContain('<older_topic_summary>');
  });

  it('counts tool schemas before history', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'current' }];
    const result = buildLocalContext({
      messages,
      system: 'system',
      tools: [{ schema: 'x'.repeat(200) }],
      config,
    });
    expect(result).toMatchObject({ fits: false, reason: 'current_message_exceeds_local_context' });
  });

  it('never truncates an oversized current message', () => {
    const result = buildLocalContext({
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
      system: 'system',
      config,
    });
    expect(result).toMatchObject({ fits: false, reason: 'current_message_exceeds_local_context' });
  });

  it('keeps the active user and tool exchange as one required tail', () => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'current question' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'file_read', arguments: {} } }] },
      { role: 'tool', content: 'current tool result' },
    ] as any;
    const result = buildLocalContext({
      messages,
      system: 'system',
      config,
    });

    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.messages).toEqual(messages.slice(2));
  });
});
