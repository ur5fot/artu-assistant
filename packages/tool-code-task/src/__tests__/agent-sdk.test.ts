import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: any) => mockQuery(opts),
}));

import { runAgent } from '../agent-sdk.js';

describe('runAgent', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('emits progress for text blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Analyzing code' }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({ workdir: '/tmp/r2-dev-x', task: 'test', onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('Analyzing'))).toBe(true);
  });

  it('emits progress for tool_use blocks', async () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/App.tsx' } }] } };
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({ workdir: '/tmp/r2-dev-x', task: 'test', onProgress: (m) => progress.push(m) });

    expect(progress.some((p) => p.includes('src/App.tsx'))).toBe(true);
    expect(progress.some((p) => p.toLowerCase().includes('npm test'))).toBe(true);
  });

  it('passes cwd and task to SDK', async () => {
    async function* gen() { yield { type: 'result' }; }
    mockQuery.mockReturnValueOnce(gen());

    await runAgent({ workdir: '/tmp/r2-dev-y', task: 'do thing', context: 'use X', onProgress: () => {} });

    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('do thing'),
      options: expect.objectContaining({ cwd: '/tmp/r2-dev-y' }),
    }));
    const prompt = mockQuery.mock.calls[0][0].prompt;
    expect(prompt).toContain('use X');
  });

  it('stops on aborted signal', async () => {
    const controller = new AbortController();
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } };
      controller.abort();
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } };
    }
    mockQuery.mockReturnValueOnce(gen());

    const progress: string[] = [];
    await runAgent({
      workdir: '/tmp/r2-dev-z',
      task: 'test',
      onProgress: (m) => progress.push(m),
      signal: controller.signal,
    });

    expect(progress.some((p) => p.includes('first'))).toBe(true);
    expect(progress.some((p) => p.includes('second'))).toBe(false);
  });
});
