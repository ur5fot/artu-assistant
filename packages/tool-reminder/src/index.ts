import type { ToolDefinition, ToolResult } from '@r2/shared';
import type { Schedule } from './schedule-types.js';

export type { Schedule } from './schedule-types.js';

export interface ReminderStoreLike {
  create(text: string, schedule: Schedule): number;
  list(): Array<{ id: number; text: string; schedule: Schedule; next_fire_at_ms: number }>;
  delete(id: number): boolean;
}

interface ReminderDeps {
  reminderStore: ReminderStoreLike | null;
}

function requireStore(deps: ReminderDeps): ReminderStoreLike {
  if (!deps.reminderStore) {
    throw new Error('Reminder store is not available');
  }
  return deps.reminderStore;
}

const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['once'] },
        at_iso: { type: 'string', description: 'ISO 8601 datetime in the future' },
      },
      required: ['kind', 'at_iso'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['daily'] },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'hour', 'minute'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['weekly'] },
        weekdays: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: 6 },
          description: '0 = Sunday, 6 = Saturday',
        },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'weekdays', 'hour', 'minute'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['monthly'] },
        day_of_month: { type: 'integer', minimum: 1, maximum: 31 },
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
      },
      required: ['kind', 'day_of_month', 'hour', 'minute'],
    },
  ],
};

function validateSchedule(s: any): string | null {
  if (!s || typeof s !== 'object') return 'schedule is required';
  const hourOk = (h: any) => Number.isInteger(h) && h >= 0 && h <= 23;
  const minOk = (m: any) => Number.isInteger(m) && m >= 0 && m <= 59;
  switch (s.kind) {
    case 'once': {
      const t = Date.parse(s.at_iso);
      if (!Number.isFinite(t)) return 'once.at_iso must be a valid ISO datetime';
      return null;
    }
    case 'daily':
      if (!hourOk(s.hour) || !minOk(s.minute)) return 'daily hour/minute out of range';
      return null;
    case 'weekly':
      if (!Array.isArray(s.weekdays) || s.weekdays.length === 0) return 'weekly.weekdays must be a non-empty array';
      if (s.weekdays.some((d: any) => !Number.isInteger(d) || d < 0 || d > 6)) return 'weekly.weekdays values must be integers 0-6';
      if (!hourOk(s.hour) || !minOk(s.minute)) return 'weekly hour/minute out of range';
      return null;
    case 'monthly':
      if (!Number.isInteger(s.day_of_month) || s.day_of_month < 1 || s.day_of_month > 31) return 'monthly.day_of_month must be 1-31';
      if (!hourOk(s.hour) || !minOk(s.minute)) return 'monthly hour/minute out of range';
      return null;
    default:
      return `unknown schedule.kind: ${s.kind}`;
  }
}

export function createReminderCreateTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_create',
    description:
      'Создать напоминание с будильником (60s звон × 3 цикла). schedule — once/daily/weekly/monthly. Переводи натуральную речь ("через 5 часов", "каждый день в 9", "по пн и ср в 18:30") в структуру schedule. Используй текущее время из system prompt для расчёта at_iso в "once".',
    permissionLevel: 'auto',
    provider: 'claude',
    command: {
      name: 'нагадай',
      description: 'Створити нагадування',
      params: [{ name: 'text', required: true, description: 'Що нагадати' }],
    },
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст напоминания' },
        schedule: SCHEDULE_SCHEMA,
      },
      required: ['text', 'schedule'],
    },
    async handler(input): Promise<ToolResult> {
      const store = requireStore(deps);
      const text = String((input as any).text ?? '').trim();
      const schedule = (input as any).schedule as Schedule;
      if (!text) return { success: false, error: 'text is required' };
      const scheduleError = validateSchedule(schedule);
      if (scheduleError) return { success: false, error: scheduleError };
      try {
        const id = store.create(text, schedule);
        return {
          success: true,
          data: { id, text, schedule },
          display: { type: 'text', content: `⏰ Напоминание #${id} создано: ${text}` },
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to create reminder',
        };
      }
    },
  };
}

export function createReminderListTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_list',
    description: 'Показать активные напоминания пользователя.',
    permissionLevel: 'auto',
    provider: 'all',
    command: {
      name: 'нагадування',
      description: 'Список активних нагадувань',
      params: [],
    },
    parameters: { type: 'object', properties: {} },
    async handler(): Promise<ToolResult> {
      const store = requireStore(deps);
      const items = store.list();
      if (items.length === 0) {
        return { success: true, data: [], display: { type: 'text', content: 'Активных напоминаний нет' } };
      }
      const lines = items.map((r) => {
        const when = new Date(r.next_fire_at_ms).toLocaleString('uk-UA');
        return `#${r.id} — ${r.text} (следующее: ${when}, ${r.schedule.kind})`;
      });
      return {
        success: true,
        data: items,
        display: { type: 'text', content: lines.join('\n') },
      };
    },
  };
}

export function createReminderDeleteTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_delete',
    description: 'Удалить напоминание по id.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'ID напоминания' } },
      required: ['id'],
    },
    async handler(input): Promise<ToolResult> {
      const store = requireStore(deps);
      const id = Number((input as any).id);
      if (!Number.isFinite(id) || id <= 0) {
        return { success: false, error: 'id is required and must be a positive integer' };
      }
      const ok = store.delete(id);
      return ok
        ? { success: true, data: { id }, display: { type: 'text', content: `Напоминание #${id} удалено` } }
        : { success: false, error: `Напоминание #${id} не найдено` };
    },
  };
}

export function createTool(deps: ReminderDeps): ToolDefinition[] {
  return [
    createReminderCreateTool(deps),
    createReminderListTool(deps),
    createReminderDeleteTool(deps),
  ];
}

export default createTool;
