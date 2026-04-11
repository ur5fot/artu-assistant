import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluate } from './evaluator.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

describe('evaluate', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it('parses passed=true response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "matches expected"}' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result).toEqual({ passed: true, reason: 'matches expected' });
  });

  it('parses passed=false response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": false, "reason": "facts wrong"}' }],
    });

    const result = await evaluate({
      input: 'math',
      expected: '4',
      actualText: '5',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
  });

  it('sends toolUseExpected in user message when provided', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "ok"}' }],
    });

    await evaluate({
      input: 'weather',
      expected: 'use search',
      actualText: 'sunny',
      actualToolCalls: ['web_search'],
      toolUseExpected: ['web_search'],
    });

    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages[0].content;
    expect(userMsg).toContain('web_search');
  });

  it('fail-closed on API error', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API down'));

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('API');
  });

  it('extracts JSON from markdown code fences', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{"passed": true, "reason": "ok"}\n```' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result).toEqual({ passed: true, reason: 'ok' });
  });

  it('extracts JSON object from preamble text', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Here is my response: {"passed": false, "reason": "wrong"}' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result).toEqual({ passed: false, reason: 'wrong' });
  });

  it('fail-closed on invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not json' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('invalid JSON');
  });

  it('fail-closed on missing fields', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"only": "this"}' }],
    });

    const result = await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('incomplete');
  });

  it('uses CLAUDE_HAIKU_MODEL env when set', async () => {
    process.env.CLAUDE_HAIKU_MODEL = 'custom-haiku';
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"passed": true, "reason": "ok"}' }],
    });

    await evaluate({
      input: 'hi',
      expected: 'greeting',
      actualText: 'hello',
      actualToolCalls: [],
      toolUseExpected: null,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'custom-haiku' }),
    );
    delete process.env.CLAUDE_HAIKU_MODEL;
  });
});
