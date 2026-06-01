import type { ToolDefinition, ToolResult } from '@r2/shared';
import type { EmailPendingRow, EmailStoreLike, ImapClientLike } from './types.js';

export type { EmailStoreLike, ImapClientLike } from './types.js';

interface Deps {
  emailStore: EmailStoreLike | null;
  imapClient: ImapClientLike | null;
}

function toListItem(row: EmailPendingRow) {
  return {
    id: row.id,
    account_id: row.account_id,
    from: row.from_addr,
    subject: row.subject,
    snippet: row.snippet,
    importance: row.importance,
    received_at: row.received_at,
    delivered: row.delivered_at !== null,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  const base = Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.min(Math.max(base, min), max);
}

function createEmailsListTool(deps: Deps): ToolDefinition {
  return {
    name: 'emails_list',
    description:
      'Вернуть последние важные письма из всех подключённых ящиков, отсортированные по приоритету и времени. Используй когда юзер спрашивает "что в почте", "новые письма", "покажи важное". Возвращает JSON массив.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Максимум писем (default 10, max 50)' },
        since_hours: { type: 'number', description: 'За сколько часов назад смотреть (default 720 = 30 дней, max 8760 = 1 год)' },
      },
    },
    command: {
      name: 'почта',
      description: 'Список важных писем',
      params: [],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.emailStore) {
        return { success: false, error: 'Email integration is not enabled on this server' };
      }
      const limit = clampInt(params.limit, 10, 1, 50);
      const sinceHours = clampInt(params.since_hours, 720, 1, 8760);
      const rows = deps.emailStore.fetchInWindow(sinceHours, limit, Date.now());
      return { success: true, data: rows.map(toListItem) };
    },
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function createEmailsStatusTool(deps: Deps): ToolDefinition {
  return {
    name: 'emails_status',
    description:
      'Статус почты для проверок и сводок («чек», «что по почте», «всё ли разобрано», статусный обзор). ' +
      'Возвращает { awaiting: письма, ждущие разбора (непросмотренные — без срочного пинга и без дайджеста — ЛЮБОГО возраста, по важности), ' +
      'awaiting_count: всего таких, handled_last_7d: сколько важных уже отправлено тебе (срочный пинг или дайджест) за 7 дней }. ' +
      'Используй ЭТО для статуса/«чек»; emails_list — только для явного просмотра писем за период.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Максимум писем в awaiting (default 10, max 50)' },
      },
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.emailStore) {
        return { success: false, error: 'Email integration is not enabled on this server' };
      }
      const limit = clampInt(params.limit, 10, 1, 50);
      const awaiting = deps.emailStore.fetchPendingUndelivered(limit);
      return {
        success: true,
        data: {
          awaiting: awaiting.map(toListItem),
          awaiting_count: deps.emailStore.countPendingUndelivered(),
          handled_last_7d: deps.emailStore.countHandledSince(Date.now() - SEVEN_DAYS_MS),
        },
      };
    },
  };
}

function createEmailsGetTool(deps: Deps): ToolDefinition {
  return {
    name: 'emails_get',
    description:
      'Получить полное тело письма по id (берёшь id из результата emails_list). Делает запрос к IMAP, не кешируется. Используй когда юзер просит показать или разобрать конкретное письмо.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'id записи из emails_list' },
      },
      required: ['id'],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.emailStore || !deps.imapClient) {
        return { success: false, error: 'Email integration is not enabled on this server' };
      }
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return { success: false, error: 'id must be a positive number' };
      }
      const row = deps.emailStore.findByPendingId(id);
      if (!row) return { success: false, error: `Email with id=${id} not found` };
      const account = deps.imapClient.getAccount(row.account_id);
      if (!account) {
        return { success: false, error: `Account "${row.account_id}" is no longer configured` };
      }
      try {
        const full = await deps.imapClient.fetchFullBody(account, row.message_uid);
        return {
          success: true,
          data: {
            id: row.id,
            from: full.from,
            subject: full.subject,
            received_at: full.receivedAt,
            body_text: full.bodyText,
          },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createTool(deps: Deps): ToolDefinition[] {
  return [createEmailsListTool(deps), createEmailsStatusTool(deps), createEmailsGetTool(deps)];
}

export default createTool;
