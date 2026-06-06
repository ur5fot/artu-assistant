import { describe, it, expect } from 'vitest';
import { buildActivityDigest } from '../digest.js';
import type { ActivityRange, WindowRowLike } from '../types.js';

const MIN = 60_000;
const T0 = 1_750_000_000_000; // fixed base epoch (a "midnight")

function range(fromMin = 0, toMin = 600, label = 'тест'): ActivityRange {
  return { from: T0 + fromMin * MIN, to: T0 + toMin * MIN, label };
}

/** Build a row using minute offsets from T0. */
function row(
  app: string,
  title: string,
  startMin: number,
  endMin: number,
  url?: string,
): WindowRowLike {
  return {
    app_name: app,
    window_title: title,
    started_at: T0 + startMin * MIN,
    last_seen_at: T0 + endMin * MIN,
    url: url ?? null,
  };
}

describe('buildActivityDigest', () => {
  it('empty window → zeros and empty arrays', () => {
    const d = buildActivityDigest([], [], range());
    expect(d.total_active_min).toBe(0);
    expect(d.context_switches).toBe(0);
    expect(d.by_app).toEqual([]);
    expect(d.top_sites).toEqual([]);
    expect(d.timeline).toEqual([]);
    expect(d.range.label).toBe('тест');
  });

  it('excludes idle apps (loginwindow / ScreenSaverEngine)', () => {
    const rows = [
      row('loginwindow', 'locked', 0, 60),
      row('ScreenSaverEngine', 'saver', 60, 120),
      row('Code', 'work', 120, 150),
    ];
    const d = buildActivityDigest(rows, [], range());
    expect(d.total_active_min).toBe(30);
    expect(d.by_app).toEqual([{ app: 'Code', minutes: 30, share: 1 }]);
  });

  it('by_app: per-app minutes + share, most time first', () => {
    const rows = [
      row('Code', 'a', 0, 60),
      row('Slack', 's', 100, 120),
    ];
    const d = buildActivityDigest(rows, [], range());
    expect(d.total_active_min).toBe(80);
    expect(d.by_app).toEqual([
      { app: 'Code', minutes: 60, share: 0.75 },
      { app: 'Slack', minutes: 20, share: 0.25 },
    ]);
  });

  it('glues adjacent same-app rows into one timeline run, longest sub-title as label', () => {
    const rows = [
      row('Code', 'editing a.ts', 0, 30),
      row('Code', 'editing b.ts', 30, 50),
      row('Slack', 'dm', 50, 60),
    ];
    const d = buildActivityDigest(rows, [], range());
    expect(d.context_switches).toBe(1);
    expect(d.timeline).toEqual([
      { from: T0, to: T0 + 50 * MIN, app: 'Code', title: 'editing a.ts', min: 50 },
      { from: T0 + 50 * MIN, to: T0 + 60 * MIN, app: 'Slack', title: 'dm', min: 10 },
    ]);
  });

  it('drops runs shorter than 3 min from timeline but still counts switches', () => {
    const rows = [
      row('Code', 'a', 0, 30),
      row('Slack', 'ping', 30, 32), // 2 min — notable enough to switch, not to list
      row('Code', 'b', 32, 60),
    ];
    const d = buildActivityDigest(rows, [], range());
    expect(d.context_switches).toBe(2); // Code → Slack → Code
    expect(d.timeline.map((t) => `${t.app}:${t.min}`)).toEqual(['Code:30', 'Code:28']);
  });

  it('clamps durations to the range', () => {
    const rows = [
      // starts before from, ends after to relative to a 0..60 window
      row('Code', 'spanning', -10, 90),
      // entirely before the window → excluded
      row('Slack', 'earlier', -120, -100),
    ];
    const d = buildActivityDigest(rows, [], range(0, 60));
    expect(d.total_active_min).toBe(60);
    expect(d.by_app).toEqual([{ app: 'Code', minutes: 60, share: 1 }]);
  });

  it('top_sites: groups by host, strips www, scheme-optional', () => {
    const rows = [
      row('Chrome', 'yt', 0, 15, 'https://www.youtube.com/watch?v=1'),
      row('Chrome', 'gh', 20, 30, 'github.com/r2/foo'),
      row('Chrome', 'yt2', 35, 40, 'https://youtube.com/other'),
      row('Chrome', 'blank', 45, 50, ''),
    ];
    const d = buildActivityDigest(rows, [], range());
    expect(d.top_sites).toEqual([
      { host: 'youtube.com', minutes: 20 },
      { host: 'github.com', minutes: 10 },
    ]);
  });

  it('ignores unparseable URLs in top_sites', () => {
    const rows = [row('Chrome', 'weird', 0, 10, 'not a url at all ::::')];
    const d = buildActivityDigest(rows, [], range());
    expect(d.top_sites).toEqual([]);
  });
});
