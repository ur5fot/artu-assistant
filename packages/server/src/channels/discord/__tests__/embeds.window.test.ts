import { describe, it, expect } from 'vitest';
import { buildWindowRestoreEmbed, type WindowRestoreEvent } from '../embeds.js';

const EVENT: WindowRestoreEvent = {
  away_app: 'Chrome',
  away_session_started_at: 1_700_000_000_000,
  away_session_ended_at: 1_700_003_600_000,
  current_app: 'iTerm',
};

describe('buildWindowRestoreEmbed', () => {
  it('builds the summary embed fields', () => {
    const { embed } = buildWindowRestoreEmbed(EVENT, 60);
    expect(embed.title).toBe('🔁 Restore context?');
    const byName = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName['Was on']).toBe('Chrome');
    expect(byName['For']).toBe('~60min');
    expect(byName['Now on']).toBe('iTerm');
  });

  it('encodes away_app + session timestamps in the Show titles button', () => {
    const { components } = buildWindowRestoreEmbed(EVENT, 60);
    const btn = components[0]?.buttons[0];
    expect(btn?.label).toBe('Show titles');
    expect(btn?.style).toBe('primary');
    expect(btn?.customId).toBe(
      `window:show:Chrome:${EVENT.away_session_started_at}:${EVENT.away_session_ended_at}`,
    );
  });

  // Discord throws if a button custom_id exceeds 100 chars. A very long app
  // name would push the id over the limit and fail the entire publish, so the
  // button is dropped (summary embed still renders) rather than crashing.
  it('omits the button when the customId would exceed 100 chars', () => {
    const longApp = 'A'.repeat(80);
    const { embed, components } = buildWindowRestoreEmbed(
      { ...EVENT, away_app: longApp },
      60,
    );
    expect(components).toHaveLength(0);
    // Summary still renders so the ping is not lost.
    expect(embed.title).toBe('🔁 Restore context?');
  });

  it('keeps the button when the customId is exactly at the limit', () => {
    // window:show: (12) + app + : + 13 + : + 13 = 40 + app; 60-char app => 100.
    const app = 'B'.repeat(60);
    const { components } = buildWindowRestoreEmbed({ ...EVENT, away_app: app }, 60);
    expect(components[0]?.buttons[0]?.customId.length).toBe(100);
  });

  // Privacy regression: titles must NEVER appear in the default embed. They can
  // leak sensitive context (filenames, DM names, banking URLs) to shoulder
  // surfers; the user must click "Show titles" for an ephemeral reveal.
  it('never includes a titles field in the default embed', () => {
    const { embed } = buildWindowRestoreEmbed(EVENT, 60);
    const names = (embed.fields ?? []).map((f) => f.name.toLowerCase());
    expect(names).not.toContain('titles');
    expect(names).not.toContain('top windows');
    expect(names).not.toContain('windows');
    expect(embed.description).toBeUndefined();
  });
});
