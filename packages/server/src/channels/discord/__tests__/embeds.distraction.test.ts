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

  it('emits the four pullback buttons with the dwell key encoded', () => {
    const { components } = buildDistractionNudge(EVENT);
    const buttons = components[0]?.buttons ?? [];
    expect(buttons.map((b) => b.customId)).toEqual([
      `distract:back:${RUN_START}`,
      `distract:work:Chrome:${RUN_START}`,
      `distract:done:Chrome:${RUN_START}`,
      `distract:snooze:Chrome:${RUN_START}`,
    ]);
  });

  it('labels the buttons per spec, with the snooze window in the snooze label', () => {
    const { components } = buildDistractionNudge({ ...EVENT, snoozeMin: 45 });
    const buttons = components[0]?.buttons ?? [];
    expect(buttons.map((b) => b.label)).toEqual([
      'Возвращаюсь',
      'Это по работе',
      '✅ Закончил',
      'Отстань на 45м',
    ]);
    expect(buttons.map((b) => b.style)).toEqual([
      'success',
      'secondary',
      'secondary',
      'danger',
    ]);
  });

  it('drops the done button alongside work/snooze when the app name is too long', () => {
    const longApp = 'A'.repeat(90);
    const { components } = buildDistractionNudge({ ...EVENT, app: longApp });
    const buttons = components[0]?.buttons ?? [];
    // The done id embeds the app verbatim, so it falls under the same guard.
    expect(buttons.some((b) => b.customId.startsWith('distract:done:'))).toBe(false);
    // The app-free ack still survives.
    expect(buttons.map((b) => b.customId)).toEqual([`distract:back:${RUN_START}`]);
  });

  // A long window title / LLM work summary must not push the body past
  // Discord's 2000-char cap — the component-bearing send is direct (no
  // splitter), and a throw there would skip onPublished and re-burn judge calls.
  it('clamps a very long title and work summary so the body stays well under 2000', () => {
    const { content } = buildDistractionNudge({
      ...EVENT,
      title: 'x'.repeat(5000),
      workSummary: 'y'.repeat(5000),
    });
    expect(content.length).toBeLessThanOrEqual(1900);
    // The call-to-action survives because the per-field caps leave room for it.
    expect(content).toContain('Вернёшься?');
  });

  it('hard-caps the whole body when even the app name is pathologically long', () => {
    const { content } = buildDistractionNudge({ ...EVENT, app: 'A'.repeat(5000) });
    expect(content.length).toBeLessThanOrEqual(1900);
    expect(content.endsWith('…')).toBe(true);
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
