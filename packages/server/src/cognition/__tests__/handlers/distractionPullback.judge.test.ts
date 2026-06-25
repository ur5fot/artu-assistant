import { describe, it, expect, vi } from 'vitest';
import {
  buildJudgePrompt,
  judgeDistraction,
  type TimelineEntry,
  type CurrentDwell,
  type FeedbackHint,
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

  it('instructs the judge to return unknown on empty/uninformative titles', () => {
    const { system } = buildJudgePrompt(TIMELINE, CURRENT);
    expect(system).toContain('unknown');
    expect(system).toContain('лучше промолчать, чем гадать');
  });

  it('draws the distracted/break line at content format: chosen leisure is a break', () => {
    const { system } = buildJudgePrompt(TIMELINE, CURRENT);
    // chosen leisure (music/film/games) → break, any hour
    expect(system).toMatch(/музык/i);
    expect(system).toContain('break');
    // distracted is reserved for infinite/feed formats
    expect(system).toMatch(/лент/i);
    expect(system).toMatch(/Shorts|Reels|TikTok/i);
  });
});

describe('buildJudgePrompt — feedback hint', () => {
  const SIG = 'Google Chrome:facebook';

  it('omits the feedback block when hint is undefined', () => {
    const { user } = buildJudgePrompt(TIMELINE, CURRENT);
    expect(user).not.toMatch(/сигнатур/i);
    expect(user).not.toMatch(/работу/);
  });

  it('emits a hard "верни working" instruction for work>=2 (mentions signature)', () => {
    const hint: FeedbackHint = { signature: SIG, work: 3, done: 0 };
    const { user } = buildJudgePrompt(TIMELINE, CURRENT, hint);
    expect(user).toContain(SIG);
    expect(user).toContain('верни "working"');
    expect(user).toContain('3');
    // no soft "1×" line when hard bias applies
    expect(user).not.toContain('1× сказал');
    // no done line when done==0
    expect(user).not.toMatch(/не торопись/);
  });

  it('emits only a soft "учитывай" line for work==1 (no hard instruction)', () => {
    const hint: FeedbackHint = { signature: SIG, work: 1, done: 0 };
    const { user } = buildJudgePrompt(TIMELINE, CURRENT, hint);
    expect(user).toContain(SIG);
    expect(user).toContain('учитывай');
    expect(user).not.toContain('верни "working"');
    expect(user).not.toMatch(/не торопись/);
  });

  it('emits a "не торопись" line for done>=1', () => {
    const hint: FeedbackHint = { signature: SIG, work: 0, done: 2 };
    const { user } = buildJudgePrompt(TIMELINE, CURRENT, hint);
    expect(user).toContain(SIG);
    expect(user).toMatch(/не торопись/);
    expect(user).not.toContain('верни "working"');
    expect(user).not.toContain('учитывай');
  });

  it('lets work and done lines co-occur', () => {
    const hint: FeedbackHint = { signature: SIG, work: 2, done: 1 };
    const { user } = buildJudgePrompt(TIMELINE, CURRENT, hint);
    expect(user).toContain('верни "working"');
    expect(user).toMatch(/не торопись/);
  });

  it('emits the soft line (not the hard one) alongside done for work==1 && done>=1', () => {
    const hint: FeedbackHint = { signature: SIG, work: 1, done: 1 };
    const { user } = buildJudgePrompt(TIMELINE, CURRENT, hint);
    // soft + done co-occur, hard bias stays suppressed (mutually exclusive branch)
    expect(user).toContain('учитывай');
    expect(user).toMatch(/не торопись/);
    expect(user).not.toContain('верни "working"');
  });

  it('threads the hint through judgeDistraction into the prompt', async () => {
    const { anthropic, create } = fakeAnthropic(
      makeToolUseResponse({
        verdict: 'working',
        confidence: 70,
        reason: 'r',
        work_summary: 'w',
      }),
    );
    const hint: FeedbackHint = { signature: SIG, work: 3, done: 0 };
    await judgeDistraction(
      { anthropic: anthropic as any, model: 'm', signal: notAborted },
      TIMELINE,
      CURRENT,
      hint,
    );
    const callArgs = (create.mock.calls as any[])[0][0] as any;
    expect(callArgs.messages[0].content).toContain('верни "working"');
    expect(callArgs.messages[0].content).toContain(SIG);
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

  it('accepts an unknown verdict (judge stays silent on empty signal)', async () => {
    const { anthropic } = fakeAnthropic(
      makeToolUseResponse({
        verdict: 'unknown',
        confidence: 10,
        reason: 'заголовки пустые',
        work_summary: '',
      }),
    );
    const result = await judgeDistraction(
      { anthropic: anthropic as any, model: 'm', signal: notAborted },
      TIMELINE,
      CURRENT,
    );
    expect(result).toEqual({
      verdict: 'unknown',
      confidence: 10,
      reason: 'заголовки пустые',
      work_summary: '',
    });
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
