import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresidioClient } from './presidio.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PresidioClient', () => {
  let client: PresidioClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PresidioClient({
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
    });
  });

  it('calls analyzer and returns detected entities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
      ],
    });

    const results = await client.analyze('My email is john@example.com');
    expect(results).toEqual([
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ]);

    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5002/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'My email is john@example.com',
        language: 'en',
        entities: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it('calls anonymizer with custom operators', async () => {
    const analyzerResults = [
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ];
    const operators = {
      EMAIL_ADDRESS: { type: 'replace', new_value: '<EMAIL:a7f3>' },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: 'My email is <EMAIL:a7f3>',
        items: [{ operator: 'replace', entity_type: 'EMAIL_ADDRESS', start: 12, end: 24, text: '<EMAIL:a7f3>' }],
      }),
    });

    const result = await client.anonymize('My email is john@example.com', analyzerResults, operators);
    expect(result.text).toBe('My email is <EMAIL:a7f3>');
  });

  it('throws on analyzer HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(client.analyze('test')).rejects.toThrow('Presidio analyzer error: 500');
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(client.analyze('test')).rejects.toThrow('fetch failed');
  });
});
