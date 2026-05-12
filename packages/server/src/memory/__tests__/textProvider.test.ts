import { describe, it, expect, vi } from 'vitest';
import { createOllamaTextProvider, createClaudeTextProvider } from '../textProvider.js';

describe('createOllamaTextProvider', () => {
  it('passes through to ollama.chat and returns its text', async () => {
    const ollama = { chat: vi.fn().mockResolvedValue({ text: 'hello' }) } as any;
    const provider = createOllamaTextProvider(ollama);

    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qwen2.5:7b',
    });

    expect(result.text).toBe('hello');
    expect(ollama.chat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'qwen2.5:7b',
    });
  });
});

describe('createClaudeTextProvider', () => {
  it('calls anthropic.messages.create and returns first text block', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'claude response' }],
        }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.text).toBe('claude response');
    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0,
        messages: [{ role: 'user', content: 'hi' }],
        system: undefined,
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('passes a bounded request timeout so a wedged call cannot block the index queue', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5-20251001',
    });

    const optionsArg = anthropic.messages.create.mock.calls[0][1];
    expect(optionsArg).toBeDefined();
    expect(typeof optionsArg.timeout).toBe('number');
    // Anthropic SDK default is 10 minutes; the provider must override with a
    // bounded value well below that so a single hung call cannot stall the
    // serialized indexTurn queue for the full SDK window.
    expect(optionsArg.timeout).toBeLessThan(60_000);
    expect(optionsArg.timeout).toBeGreaterThan(0);
  });

  it('merges system messages into the system parameter', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    await provider.chat({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(anthropic.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        system: 'be terse',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('returns empty string when no text content block is present', async () => {
    const anthropic = {
      messages: {
        create: vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', id: 'x' }] }),
      },
    } as any;

    const provider = createClaudeTextProvider(anthropic);
    const result = await provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result.text).toBe('');
  });
});
