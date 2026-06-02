import { describe, it, expect } from 'vitest';
import { buildDistractionNudge, type DistractionNudgeEvent } from '../embeds.js';

const RUN_START = 1_700_000_000_000;

const EVENT: DistractionNudgeEvent = {
  app: 'Chrome',
  title: 'YouTube',
  dwellMin: 30,
  workSummary: 'писал сервер',
  runStart: RUN_START,
  snoozeMin: 60,
};

describe('buildDistractionNudge', () => {
  it('renders the dwell summary with title and work context', () => {
    const { content } = buildDistractionNudge(EVENT);
    expect(content).toBe(
      `🧲 Ты ~30 мин в Chrome: YouTube. До этого: писал сервер. Вернёшься?`,
    );
  });

  it('omits the title/work fragments when they are empty', () => {
    const { content } = buildDistractionNudge({ ...EVENT, title: '', workSummary: '' });
    expect(content).toBe('🧲 Ты ~30 мин в Chrome. Вернёшься?');
  });

  it('emits the three pullback buttons with the dwell key encoded', () => {
    const { components } = buildDistractionNudge(EVENT);
    const buttons = components[0]?.buttons ?? [];
    expect(buttons.map((b) => b.customId)).toEqual([
      `distract:back:${RUN_START}`,
      `distract:work:Chrome:${RUN_START}`,
      `distract:snooze:Chrome:${RUN_START}`,
    ]);
  });

  it('labels the buttons per spec, with the snooze window in the snooze label', () => {
    const { components } = buildDistractionNudge({ ...EVENT, snoozeMin: 45 });
    const buttons = components[0]?.buttons ?? [];
    expect(buttons.map((b) => b.label)).toEqual([
      'Возвращаюсь',
      'Это по работе',
      'Отстань на 45м',
    ]);
    expect(buttons.map((b) => b.style)).toEqual(['success', 'secondary', 'danger']);
  });

  // Discord throws if a custom_id exceeds 100 chars. The work/snooze ids embed
  // the app name verbatim, so a pathologically long app drops just those two
  // buttons — the "Возвращаюсь" ack (no app in its id) and the text survive.
  it('drops the app-bearing buttons when their customId would exceed 100 chars', () => {
    const longApp = 'A'.repeat(90);
    const { content, components } = buildDistractionNudge({ ...EVENT, app: longApp });
    const buttons = components[0]?.buttons ?? [];
    expect(buttons.map((b) => b.customId)).toEqual([`distract:back:${RUN_START}`]);
    // The nudge text still renders so the pullback is not lost.
    expect(content).toContain('🧲');
  });
});
