import type { ToolDefinition, ToolResult } from '@r2/shared';
import { buildActivityDigest } from './digest.js';
import type { ActivityDeps, ActivityRange } from './types.js';

export { buildActivityDigest } from './digest.js';
export type {
  ActivityByApp,
  ActivityDeps,
  ActivityDigest,
  ActivityEpisode,
  ActivityEvalStoreLike,
  ActivityObserver,
  ActivityObserverCounts,
  ActivityRange,
  ActivityStoreLike,
  ActivityTimelineEntry,
  ActivityTopSite,
  EvalLike,
  WindowRowLike,
} from './types.js';

const DAY_MS = 86_400_000;

/** Period the agent can ask for; `today` is the default. */
export type ActivityPeriod = 'today' | 'yesterday' | 'last_24h';
const PERIODS: ActivityPeriod[] = ['today', 'yesterday', 'last_24h'];

/** RU month names in genitive, for date labels like «6 июня». */
const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Local midnight (00:00:00.000 in the host timezone) for the day of `now`. */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** «6 июня» for the local day containing `epoch`. */
function dayLabel(epoch: number): string {
  const d = new Date(epoch);
  return `${d.getDate()} ${RU_MONTHS[d.getMonth()]}`;
}

/**
 * Resolve a {@link ActivityPeriod} to a concrete window in local time:
 * - `today`     → `[localMidnight(now), now]`
 * - `yesterday` → `[localMidnight(now) − 24h, localMidnight(now)]`
 * - `last_24h`  → `[now − 24h, now]`
 *
 * Exported (and `now`-injectable) so the mapping is deterministically testable.
 */
export function resolveRange(period: ActivityPeriod, now: number): ActivityRange {
  const midnight = startOfLocalDay(now);
  switch (period) {
    case 'yesterday': {
      const from = midnight - DAY_MS;
      return { from, to: midnight, label: `вчера (${dayLabel(from)})` };
    }
    case 'last_24h':
      return { from: now - DAY_MS, to: now, label: 'последние 24 часа' };
    case 'today':
    default:
      return { from: midnight, to: now, label: `сегодня (${dayLabel(midnight)})` };
  }
}

/** Coerce a raw param into a known period; anything unknown falls back to `today`. */
function parsePeriod(raw: unknown): ActivityPeriod {
  return typeof raw === 'string' && (PERIODS as string[]).includes(raw)
    ? (raw as ActivityPeriod)
    : 'today';
}

function createActivityTool(deps: ActivityDeps): ToolDefinition {
  return {
    name: 'activity',
    description:
      'Сводка активности за компом (приложения/сайты/время/смены/отвлечения) за период. ' +
      'Зови на: проанализируй работу, чем занимался, что делал сегодня/вчера, ' +
      'экранное время, сколько сидел в X. Возвращает структурный дайджест ' +
      '(по приложениям/сайтам/таймлайну + слой наблюдателя) и готовую RU-сводку. ' +
      'Время оценочное (выборка ~30с).',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: PERIODS,
          description: 'Период: today (по умолчанию), yesterday или last_24h.',
        },
      },
    },
    command: {
      name: 'активність',
      description: 'Сводка активности за компом',
      params: [
        {
          name: 'period',
          required: false,
          description: 'today (по умолч.) / yesterday / last_24h',
        },
      ],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const { store, evalStore } = deps;
      if (!store) {
        return { success: false, error: 'digital observer выключен (WINDOW_LOGGER_ENABLED)' };
      }

      const period = parsePeriod(params.period);
      const range = resolveRange(period, Date.now());

      try {
        const rows = store.findRowsInWindow(range.from, range.to, 2000);
        const evals = evalStore ? evalStore.listEvalsInWindow(range.from, range.to) : [];
        const digest = buildActivityDigest(rows, evals, range);
        return { success: true, data: digest };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createTool(deps: ActivityDeps): ToolDefinition[] {
  return [createActivityTool(deps)];
}

export default createTool;
