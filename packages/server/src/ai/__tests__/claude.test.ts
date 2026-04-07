import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClaudeClient } from '../claude.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(),
      };
    },
  };
});

describe('Claude Client', () => {
  it('creates a client with sendMessage method', () => {
    const client = createClaudeClient();
    expect(client.sendMessage).toBeDefined();
    expect(typeof client.sendMessage).toBe('function');
  });

  it('calls Anthropic API with correct parameters', async () => {
    const client = createClaudeClient();

    const mockResponse = {
      content: [{ type: 'text', text: 'Hello' }],
      stop_reason: 'end_turn',
    };

    // Access the mocked create method
    const anthropicInstance = (client as any).anthropic;
    anthropicInstance.messages.create.mockResolvedValue(mockResponse);

    const result = await client.sendMessage({
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [],
    });

    expect(anthropicInstance.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6-20250514',
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Hi' }],
      })
    );
    expect(result).toBe(mockResponse);
  });

  it('retries once on 5xx error then throws', async () => {
    const client = createClaudeClient();
    const anthropicInstance = (client as any).anthropic;

    const error = new Error('Internal Server Error');
    (error as any).status = 500;

    anthropicInstance.messages.create
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error);

    await expect(
      client.sendMessage({ messages: [{ role: 'user', content: 'Hi' }], tools: [] })
    ).rejects.toThrow('Internal Server Error');

    expect(anthropicInstance.messages.create).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx error', async () => {
    const client = createClaudeClient();
    const anthropicInstance = (client as any).anthropic;

    const error = new Error('Bad Request');
    (error as any).status = 400;

    anthropicInstance.messages.create.mockRejectedValueOnce(error);

    await expect(
      client.sendMessage({ messages: [{ role: 'user', content: 'Hi' }], tools: [] })
    ).rejects.toThrow('Bad Request');

    expect(anthropicInstance.messages.create).toHaveBeenCalledTimes(1);
  });
});
