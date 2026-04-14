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

// Flat parameter schema — both qwen and Claude struggle with nested
// discriminated unions (`oneOf` with 4 object shapes). All schedule fields
// live at the top level; the handler reads `kind` and picks the relevant
// siblings, validating each field based on the chosen kind.
const CREATE_PARAMS_SCHEMA = {
  type: 'object' as const,
  properties: {
    text: { type: 'string', description: 'Текст напоминания' },
    kind: {
      type: 'string',
      enum: ['once', 'daily', 'weekly', 'monthly'],
      description: 'once=разово, daily=каждый день, weekly=по дням недели, monthly=раз в месяц',
    },
    at_iso: {
      type: 'string',
      description: 'Только для kind=once. ПОЛНЫЙ ISO 8601 datetime вида "2026-04-14T15:00:00" (не placeholder!). Используй ТОЛЬКО если можешь точно вычислить от текущего времени. Иначе используй after_minutes/after_hours/after_days.',
    },
    after_minutes: {
      type: 'integer',
      minimum: 1,
      description: 'Альтернатива at_iso для kind=once. Через сколько минут сработать. Пример: "через 5 минут" → after_minutes:5.',
    },
    after_hours: {
      type: 'integer',
      minimum: 1,
      description: 'Альтернатива at_iso для kind=once. Через сколько часов сработать. Пример: "через 5 часов" → after_hours:5.',
    },
    after_days: {
      type: 'integer',
      minimum: 1,
      description: 'Альтернатива at_iso для kind=once. Через сколько дней сработать. Пример: "завтра" → after_days:1.',
    },
    hour: {
      type: 'integer',
      minimum: 0,
      maximum: 23,
      description: 'Час 0-23. Нужен для kind=daily|weekly|monthly.',
    },
    minute: {
      type: 'integer',
      minimum: 0,
      maximum: 59,
      description: 'Минута 0-59. Нужна для kind=daily|weekly|monthly.',
    },
    weekdays: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
      description: 'Только для kind=weekly. 0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб. Пример: [1,3] = пн и ср.',
    },
    day_of_month: {
      type: 'integer',
      minimum: 1,
      maximum: 31,
      description: 'Только для kind=monthly. День месяца 1-31. 31 → последний день месяца.',
    },
  },
  required: ['text'],
};

interface FlatCreateInput {
  text?: unknown;
  kind?: unknown;
  at_iso?: unknown;
  after_minutes?: unknown;
  after_hours?: unknown;
  after_days?: unknown;
  hour?: unknown;
  minute?: unknown;
  weekdays?: unknown;
  day_of_month?: unknown;
}

function parseScheduleFromFlat(input: FlatCreateInput, now: number = Date.now()): Schedule | string {
  const hourOk = (h: unknown): h is number => Number.isInteger(h) && (h as number) >= 0 && (h as number) <= 23;
  const minOk = (m: unknown): m is number => Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 59;
  const posInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
  // Default `kind` to 'once' when the caller omitted it but supplied a
  // one-shot delta or an ISO timestamp. Helps models that sometimes drop
  // the discriminator field in their first tool_call attempt. We do NOT
  // default for the recurring shapes (daily/weekly/monthly) because the
  // intent is ambiguous (hour/minute alone can't tell daily vs weekly).
  let kind = input.kind;
  if (!kind && (posInt(input.after_minutes) || posInt(input.after_hours) || posInt(input.after_days) || typeof input.at_iso === 'string')) {
    kind = 'once';
  }
  switch (kind) {
    case 'once': {
      // Prefer delta params (model-friendly) over at_iso (requires ISO math).
      let deltaMs = 0;
      if (posInt(input.after_minutes)) deltaMs += input.after_minutes * 60_000;
      if (posInt(input.after_hours)) deltaMs += input.after_hours * 3_600_000;
      if (posInt(input.after_days)) deltaMs += input.after_days * 86_400_000;
      if (deltaMs > 0) {
        return { kind: 'once', at_iso: new Date(now + deltaMs).toISOString() };
      }
      // Fall back to literal ISO string.
      const at = String(input.at_iso ?? '');
      const t = Date.parse(at);
      if (!Number.isFinite(t)) {
        return 'kind=once требует либо at_iso (валидный ISO 8601), либо after_minutes/after_hours/after_days (целое ≥1)';
      }
      return { kind: 'once', at_iso: at };
    }
    case 'daily': {
      if (!hourOk(input.hour) || !minOk(input.minute)) return 'kind=daily требует hour (0-23) и minute (0-59)';
      return { kind: 'daily', hour: input.hour, minute: input.minute };
    }
    case 'weekly': {
      if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
        return 'kind=weekly требует непустой массив weekdays (0=вс..6=сб)';
      }
      const days = input.weekdays as unknown[];
      if (days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
        return 'weekdays должен содержать только целые числа 0-6';
      }
      if (!hourOk(input.hour) || !minOk(input.minute)) return 'kind=weekly требует hour (0-23) и minute (0-59)';
      return { kind: 'weekly', weekdays: days as number[], hour: input.hour, minute: input.minute };
    }
    case 'monthly': {
      if (!Number.isInteger(input.day_of_month) || (input.day_of_month as number) < 1 || (input.day_of_month as number) > 31) {
        return 'kind=monthly требует day_of_month (1-31)';
      }
      if (!hourOk(input.hour) || !minOk(input.minute)) return 'kind=monthly требует hour (0-23) и minute (0-59)';
      return { kind: 'monthly', day_of_month: input.day_of_month as number, hour: input.hour, minute: input.minute };
    }
    default:
      return `kind должен быть once|daily|weekly|monthly, получено: ${String(input.kind)}`;
  }
}

// Exported for unit tests.
export const __test__ = { parseScheduleFromFlat };

export function createReminderCreateTool(deps: ReminderDeps): ToolDefinition {
  return {
    name: 'reminder_create',
    description:
      'Создать напоминание с будильником (60s звон × 3 цикла). Все параметры плоские. ' +
      'Для одноразовых "через N минут/часов/дней" используй after_minutes/after_hours/after_days — сервер сам вычислит точное время. ' +
      'Примеры: ' +
      '"через 2 минуты выпить воды" → {text:"выпить воды", kind:"once", after_minutes:2}; ' +
      '"через 5 часов позвонить" → {text:"позвонить", kind:"once", after_hours:5}; ' +
      '"завтра напомнить отчёт" → {text:"отчёт", kind:"once", after_days:1}; ' +
      '"каждый день в 9:00 зарядка" → {text:"зарядка", kind:"daily", hour:9, minute:0}; ' +
      '"по пн и ср в 18:30 спортзал" → {text:"спортзал", kind:"weekly", weekdays:[1,3], hour:18, minute:30}; ' +
      '"1 числа каждый месяц в 12 оплата" → {text:"оплата", kind:"monthly", day_of_month:1, hour:12, minute:0}. ' +
      'at_iso используй только если задан конкретный absolute datetime и ты уверен в арифметике.',
    permissionLevel: 'auto',
    // Flat schema works for both Ollama and Claude — 'all' re-enabled now
    // that qwen doesn't have to navigate nested oneOf discriminated unions.
    provider: 'all',
    command: {
      name: 'нагадай',
      description: 'Створити нагадування',
      params: [{ name: 'text', required: true, description: 'Що нагадати' }],
    },
    parameters: CREATE_PARAMS_SCHEMA,
    async handler(input): Promise<ToolResult> {
      const store = requireStore(deps);
      const flat = input as FlatCreateInput;
      const text = String(flat.text ?? '').trim();
      if (!text) return { success: false, error: 'text is required' };
      const parsed = parseScheduleFromFlat(flat);
      if (typeof parsed === 'string') return { success: false, error: parsed };
      try {
        const id = store.create(text, parsed);
        return {
          success: true,
          data: { id, text, schedule: parsed },
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
