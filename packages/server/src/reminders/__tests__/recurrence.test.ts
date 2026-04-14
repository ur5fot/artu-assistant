import { describe, expect, it } from 'vitest';
import { computeNextFire } from '../recurrence.js';
import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe('computeNextFire', () => {
  describe('once', () => {
    it('returns parsed timestamp for a future at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const future = local(2026, 4, 14, 12, 0).toISOString();
      const schedule: Schedule = { kind: 'once', at_iso: future };
      expect(computeNextFire(schedule, now)).toBe(Date.parse(future));
    });

    it('returns null for a past at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const past = local(2026, 4, 14, 9, 0).toISOString();
      const schedule: Schedule = { kind: 'once', at_iso: past };
      expect(computeNextFire(schedule, now)).toBeNull();
    });

    it('returns null for invalid at_iso', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'once', at_iso: 'not-a-date' };
      expect(computeNextFire(schedule, now)).toBeNull();
    });
  });

  describe('daily', () => {
    it('returns today at H:M when now is before that time', () => {
      const now = local(2026, 4, 14, 8, 30).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 14, 9, 0).getTime());
    });

    it('returns tomorrow at H:M when now is after that time', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 9, 0).getTime());
    });

    it('returns tomorrow at H:M when now equals that time exactly', () => {
      const now = local(2026, 4, 14, 9, 0).getTime();
      const schedule: Schedule = { kind: 'daily', hour: 9, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 9, 0).getTime());
    });
  });

  describe('weekly', () => {
    it('returns nearest future weekday from the list', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [1, 3, 5], hour: 18, minute: 30 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 18, 30).getTime());
    });

    it('returns today when today is in weekdays and H:M is still in future', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [2], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 14, 18, 0).getTime());
    });

    it('rolls to next week when today matches but time already passed', () => {
      const now = local(2026, 4, 14, 20, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [2], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 21, 18, 0).getTime());
    });

    it('returns null for empty weekdays', () => {
      const now = local(2026, 4, 14, 10, 0).getTime();
      const schedule: Schedule = { kind: 'weekly', weekdays: [], hour: 18, minute: 0 };
      expect(computeNextFire(schedule, now)).toBeNull();
    });
  });

  describe('monthly', () => {
    it('returns this month at day H:M when still in future', () => {
      const now = local(2026, 4, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 15, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 15, 12, 0).getTime());
    });

    it('returns next month when this month day already passed', () => {
      const now = local(2026, 4, 20, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 15, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 5, 15, 12, 0).getTime());
    });

    it('clamps day 31 to last day of February', () => {
      const now = local(2026, 2, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 2, 28, 12, 0).getTime());
    });

    it('clamps day 31 to last day of February (leap year)', () => {
      const now = local(2028, 2, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2028, 2, 29, 12, 0).getTime());
    });

    it('clamps day 31 to 30 for April', () => {
      const now = local(2026, 4, 1, 10, 0).getTime();
      const schedule: Schedule = { kind: 'monthly', day_of_month: 31, hour: 12, minute: 0 };
      expect(computeNextFire(schedule, now)).toBe(local(2026, 4, 30, 12, 0).getTime());
    });
  });
});
