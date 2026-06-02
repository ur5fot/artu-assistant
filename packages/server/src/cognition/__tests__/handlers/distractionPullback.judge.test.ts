import { describe, it, expect, vi } from 'vitest';
import {
  buildJudgePrompt,
  judgeDistraction,
  type TimelineEntry,
  type CurrentDwell,
} from '../../handlers/distractionPullback.judge.js';

const TIMELINE: TimelineEntry[] = [
  { app: 'Chrome', title: 'YouTube — random video', durationMin: 30 },
  { app: 'Chrome', title: 'localhost:3000', durationMin: 12 },
  { app: 'iTerm', title: 'npm run dev', durationMin: 45 },
];
const CURRENT: CurrentDwell = { app: 'Chrome', title: 'YouTube — random video', dwellMin: 30 };

function makeToolUseResponse(input: Record<string, unknown>, name = 'report_verdict') {
  return {
    id: 'msg_test',
    content: [{ type: 'tool_use', id: 'tu_1', name, input }],
    role: 'assistant',
    model: 'claude-haiku-4-5',
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
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function fakeAnthropic(response: unknown) {
  const create = vi.fn(async () => response);
  return { create, anthropic: { messages: { create } } };
}

const notAborted = new AbortController().signal;

describe('buildJudgePrompt', () => {
  it('renders a stable timeline + current dwell prompt (snapshot)', () => {
    const { system, user } = buildJudgePrompt(TIMELINE, CURRENT);
    expect(system).toContain('наблюдатель внимания R2');
    expect(system).toContain('report_verdict');
    expect(user).toMatchInlineSnapshot(`
      "Таймлайн активных окон (самые свежие сверху):
      - Chrome · «YouTube — random video» — 30 мин
      - Chrome · «localhost:3000» — 12 мин
      - iTerm · «npm run dev» — 45 мин

      Сейчас юзер залип здесь:
      Chrome · «YouTube — random video» — уже 30 мин

      Оцени и ответь инструментом report_verdict."
    `);
  });

  it('renders a placeholder when the timeline is empty', () => {
    const { user } = buildJudgePrompt([], CURRENT);
    expect(user).toContain('(пусто)');
  });
});

describe('judgeDistraction', () => {
  it('parses a valid tool response into the verdict structure', async () => {
    const { anthropic, create } = fakeAnthropic(
      makeToolUseResponse({
        verdict: 'distracted',
        confidence: 82,
        reason: 'Залип в YouTube',
        work_summary: 'Работал в терминале над dev-сервером',
      }),
    );
    const result = await judgeDistraction(
      { anthropic: anthropic as any, model: 'claude-haiku-4-5', signal: notAborted },
      TIMELINE,
      CURRENT,
    );
    expect(result).toEqual({
      verdict: 'distracted',
      confidence: 82,
      reason: 'Залип в YouTube',
      work_summary: 'Работал в терминале над dev-сервером',
    });
    // forces the report_verdict tool
    const callArgs = (create.mock.calls as any[])[0][0] as any;
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'report_verdict' });
    expect(callArgs.model).toBe('claude-haiku-4-5');
  });

  it('clamps and rounds out-of-range confidence', async () => {
    const { anthropic } = fakeAnthropic(
      makeToolUseResponse({
        verdict: 'working',
        confidence: 150.6,
        reason: 'r',
        work_summary: 'w',
      }),
    );
    const result = await judgeDistraction(
      { anthropic: anthropic as any, model: 'm', signal: notAborted },
      TIMELINE,
      CURRENT,
    );
    expect(result.confidence).toBe(100);
  });

  it('throws when the model returns no tool_use', async () => {
    const { anthropic } = fakeAnthropic(makeTextResponse('я подумал и решил...'));
    await expect(
      judgeDistraction(
        { anthropic: anthropic as any, model: 'm', signal: notAborted },
        TIMELINE,
        CURRENT,
      ),
    ).rejects.toThrow(/no report_verdict/);
  });

  it('throws on an invalid verdict value', async () => {
    const { anthropic } = fakeAnthropic(
      makeToolUseResponse({ verdict: 'maybe', confidence: 50, reason: 'r', work_summary: 'w' }),
    );
    await expect(
      judgeDistraction(
        { anthropic: anthropic as any, model: 'm', signal: notAborted },
        TIMELINE,
        CURRENT,
      ),
    ).rejects.toThrow(/invalid verdict/);
  });

  it('throws on a non-numeric confidence', async () => {
    const { anthropic } = fakeAnthropic(
      makeToolUseResponse({ verdict: 'break', confidence: 'high', reason: 'r', work_summary: 'w' }),
    );
    await expect(
      judgeDistraction(
        { anthropic: anthropic as any, model: 'm', signal: notAborted },
        TIMELINE,
        CURRENT,
      ),
    ).rejects.toThrow(/invalid confidence/);
  });
});
