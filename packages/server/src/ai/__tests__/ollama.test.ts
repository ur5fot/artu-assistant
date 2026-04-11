import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOllamaClient } from '../ollama.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaClient.chat', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OLLAMA_URL = 'http://localhost:11434';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';
  });

  it('calls native /api/chat with stream=false', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'Hello' }, done: true }),
    });

    const client = createOllamaClient();
    const result = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.text).toBe('Hello');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts Anthropic-style array content to flat string', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const client = createOllamaClient();
    await client.chat({
      messages: [
        { role: 'user', content: 'text one' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part A' },
            { type: 'text', text: 'part B' },
          ] as any,
        },
      ],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe('text one');
    expect(body.messages[1].content).toBe('part A\npart B');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const client = createOllamaClient();
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/500/);
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = createOllamaClient();
    await expect(client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('forwards AbortSignal to fetch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const controller = new AbortController();
    const client = createOllamaClient();
    await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
    });

    const passedSignal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal.aborted).toBe(false);
    controller.abort();
    expect(passedSignal.aborted).toBe(true);
  });

  it('uses OLLAMA_URL and OLLAMA_MODEL from env', async () => {
    process.env.OLLAMA_URL = 'http://custom:9999';
    process.env.OLLAMA_MODEL = 'llama3.2:3b';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: 'ok' }, done: true }),
    });

    const client = createOllamaClient();
    await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(mockFetch).toHaveBeenCalledWith('http://custom:9999/api/chat', expect.anything());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('llama3.2:3b');
  });
});
