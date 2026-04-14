import type { Schedule } from '@r2/tool-reminder/src/schedule-types.js';

export function computeNextFire(schedule: Schedule, now: number): number | null {
  switch (schedule.kind) {
    case 'once': {
      const ts = Date.parse(schedule.at_iso);
      if (!Number.isFinite(ts)) return null;
      return ts > now ? ts : null;
    }

    case 'daily': {
      const d = new Date(now);
      d.setHours(schedule.hour, schedule.minute, 0, 0);
      if (d.getTime() > now) return d.getTime();
      d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    case 'weekly': {
      if (schedule.weekdays.length === 0) return null;
      for (let offset = 0; offset < 14; offset++) {
        const d = new Date(now);
        d.setDate(d.getDate() + offset);
        d.setHours(schedule.hour, schedule.minute, 0, 0);
        if (!schedule.weekdays.includes(d.getDay())) continue;
        if (d.getTime() > now) return d.getTime();
      }
      return null;
    }

    case 'monthly': {
      for (let offset = 0; offset < 2; offset++) {
        const d = new Date(now);
        d.setMonth(d.getMonth() + offset, 1);
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const day = Math.min(schedule.day_of_month, lastDay);
        d.setDate(day);
        d.setHours(schedule.hour, schedule.minute, 0, 0);
        if (d.getTime() > now) return d.getTime();
      }
      return null;
    }
  }
}
