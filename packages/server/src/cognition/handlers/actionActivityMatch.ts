import type { Handler } from '../types.js';
import type { WindowHistoryStore } from '../../observers/window-history-store.js';
import type { TopicStore, OpenAction } from '../../topics/store.js';
import { stripUrl } from '../../observers/window-snapshot.js';
import { buildActionReopenComponents } from '../../channels/discord/embeds.js';

interface Deps {
  windowHistoryStore: WindowHistoryStore;
  topicStore: TopicStore;
  /** How far back to scan window_history for a matching visit. */
  lookbackHours?: number;
  /** Short cooldown after a successful auto-close publish so the handler does
   *  not re-scan every tick while other open actions linger. */
  cooldownMs?: number;
}

// Hard cap on visited URLs pulled from window_history per scan. Visits are
// deduped by URL in the store and open actions are few, so this is a generous
// backstop rather than an expected limit.
const MAX_URLS = 500;
// The action's target path must have at least this many segments before we'll
// match a visit against it. A bare domain (or a single generic segment like
// `/login`) would over-match — visiting the site's home page would wrongly
// close the action — so we require a specific deep link.
const MIN_PATH_SEGMENTS = 2;

interface HostPath {
  host: string;
  segments: string[];
}

// Split a stored `host+path` string (no scheme — that's how window-snapshot's
// stripUrl persists it) into its host and non-empty path segments.
function splitHostPath(hostPath: string): HostPath {
  const slash = hostPath.indexOf('/');
  if (slash < 0) return { host: hostPath.toLowerCase(), segments: [] };
  return {
    host: hostPath.slice(0, slash).toLowerCase(),
    segments: hostPath.slice(slash + 1).split('/').filter(Boolean),
  };
}

// Normalize an action's full target_url (scheme + query + fragment + www.) down
// to the same host+path shape window_history stores, then split it. Returns
// null when the url is missing/unparseable or its path is too shallow to match
// safely (see MIN_PATH_SEGMENTS).
function actionTarget(url: string | null): HostPath | null {
  if (!url) return null;
  const stripped = stripUrl(url);
  if (!stripped) return null;
  const hp = splitHostPath(stripped);
  if (hp.segments.length < MIN_PATH_SEGMENTS) return null;
  return hp;
}

// True when `visited` reaches the action's target: same host and the visited
// path begins with the full action path on segment boundaries (so
// `/org/repo` matches `/org/repo/issues` but never `/org/repo-other`).
function visitReachesTarget(target: HostPath, visited: HostPath): boolean {
  if (target.host !== visited.host) return false;
  if (visited.segments.length < target.segments.length) return false;
  return target.segments.every((seg, i) => visited.segments[i] === seg);
}

function formatNotice(closed: Array<{ action: OpenAction; url: string }>): string {
  const lines = closed.map(({ action, url }) => `• «${action.action}» — ${url}`);
  const head =
    closed.length === 1
      ? '✅ Закрыл задачу — ты открывал страницу:'
      : `✅ Закрыл ${closed.length} задач — ты открывал страницы:`;
  return `${head}\n${lines.join('\n')}\n\nЕсли поторопился — верни кнопкой ↩`;
}

export function createActionActivityMatchHandler(deps: Deps): Handler {
  const lookbackHours = deps.lookbackHours ?? 72;
  const cooldownMs = deps.cooldownMs ?? 6 * 3600_000;
  return {
    name: 'actionActivityMatch',
    trigger(state) {
      // Cheap gate: nothing to auto-close from activity unless some open action
      // carries a deep-enough target_url and hasn't been reopened by the user.
      const eligible = deps.topicStore
        .getOpenActions()
        .some((a) => !a.autoCloseBlocked && actionTarget(a.url) !== null);
      if (!eligible) return false;
      // Cooldown only after a successful publish (mirrors emailActionMatch):
      // skips and errors stay retry-able so a transient Discord failure doesn't
      // silence auto-close for the full window.
      const publishedRecently =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        state.now - state.lastFiredAt < cooldownMs;
      if (publishedRecently) return false;
      return true;
    },
    async run(ctx) {
      try {
        const actions = deps.topicStore.getOpenActions();
        const eligible = actions
          .filter((a) => !a.autoCloseBlocked)
          .map((a) => ({ action: a, target: actionTarget(a.url) }))
          .filter((x): x is { action: OpenAction; target: HostPath } => x.target !== null);
        if (eligible.length === 0) return { skip: true, reason: 'no actions with target_url' };

        const since = ctx.firedAt - lookbackHours * 3600_000;
        const visits = deps.windowHistoryStore.recentUrlsSince(since, MAX_URLS);
        if (visits.length === 0) return { skip: true, reason: 'no recent visited urls' };

        const closed: Array<{ action: OpenAction; url: string }> = [];
        for (const { action, target } of eligible) {
          // A visit only counts if it postdates the action — opening the page
          // before the task even existed can't have completed it.
          const hit = visits.find(
            (v) => v.last_seen_at >= action.startedAt && visitReachesTarget(target, splitHostPath(v.url)),
          );
          if (hit) closed.push({ action, url: hit.url });
        }
        if (closed.length === 0) return { skip: true, reason: 'no visited url matches an open action' };

        const now = ctx.firedAt;
        return {
          publish: true,
          content: formatNotice(closed),
          components: buildActionReopenComponents(closed.map((c) => c.action)),
          // Dismiss only after the DM lands. If the publish fails the actions
          // stay open and the next tick retries — otherwise a Discord outage
          // would silently close them with no notice and no reopen button.
          onPublished: () => {
            for (const { action } of closed) deps.topicStore.dismissAction(action.topicId, now);
          },
        };
      } catch (err) {
        return { error: true, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
