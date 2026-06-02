import type Anthropic from '@anthropic-ai/sdk';
import type { Handler, HandlerResult } from '../types.js';
import type { WindowHistoryStore } from '../../observers/window-history-store.js';
import type { DistractionEvalStore } from '../../observers/distraction-eval-store.js';
import { shouldEvaluateDistraction } from '../../observers/distraction-detector.js';
import type { DistractionCandidate } from '../../observers/distraction-detector.js';
import { buildDistractionNudge } from '../../channels/discord/embeds.js';
import {
  judgeDistraction,
  type TimelineEntry,
  type CurrentDwell,
  type JudgeResult,
} from './distractionPullback.judge.js';

const MINUTE_MS = 60_000;

/**
 * Judge callable — injected in tests with a deterministic stub, defaults to the
 * real `judgeDistraction` LLM call. The signal is threaded from `ctx.signal`.
 */
export type DistractionJudge = (
  timeline: TimelineEntry[],
  current: CurrentDwell,
  signal: AbortSignal,
) => Promise<JudgeResult>;

export interface DistractionHandlerDeps {
  store: WindowHistoryStore;
  evalStore: DistractionEvalStore;
  anthropic: Anthropic;
  model: string;
  dwellMin: number;
  workLookbackMin: number;
  judgeLookbackMin: number;
  dedupeH: number;
  reevalMin: number;
  confidencePct: number;
  dailyCap: number;
  /** Freshness bound (ms) for the detector's stale-session guard. Derived from
   *  the window-logger poll interval in production; omit in tests. */
  freshnessMs?: number;
  /** Snooze window (minutes) rendered into the nudge's "Отстань на Nм" button.
   *  Defaults to the spec default (60) when omitted. */
  snoozeMin?: number;
  /** Injectable judge for tests; defaults to the real LLM call. */
  judge?: DistractionJudge;
}

const DEFAULT_SNOOZE_MIN = 60;

function detect(deps: DistractionHandlerDeps, now: number): DistractionCandidate | null {
  return shouldEvaluateDistraction({
    now,
    store: deps.store,
    evalStore: deps.evalStore,
    dwellMin: deps.dwellMin,
    workLookbackMin: deps.workLookbackMin,
    dedupeH: deps.dedupeH,
    reevalMin: deps.reevalMin,
    dailyCap: deps.dailyCap,
    freshnessMs: deps.freshnessMs,
  });
}

// Builds the (app, title, durationMin) timeline fed to the judge — most-recent
// -first rows of window_history, split by title inside an app-run so the judge
// can tell work from leisure inside one app (spec §3.2).
function buildTimeline(deps: DistractionHandlerDeps, firedAt: number): TimelineEntry[] {
  const rows = deps.store.findRecentRows(firedAt - deps.judgeLookbackMin * MINUTE_MS);
  return rows.map((r) => ({
    app: r.app_name,
    title: r.window_title,
    durationMin: Math.max(1, Math.round((r.last_seen_at - r.started_at) / MINUTE_MS)),
  }));
}

export function createDistractionHandler(deps: DistractionHandlerDeps): Handler {
  const judge: DistractionJudge =
    deps.judge ??
    ((timeline, current, signal) =>
      judgeDistraction({ anthropic: deps.anthropic, model: deps.model, signal }, timeline, current));

  return {
    name: 'distractionPullback',
    async trigger(state) {
      return detect(deps, state.now) !== null;
    },
    async run(ctx): Promise<HandlerResult> {
      // Defensive re-check — trigger and run execute at different instants and
      // read live window history; the dwell may have ended or already been
      // worked out by now.
      const candidate = detect(deps, ctx.firedAt);
      if (candidate === null) return { skip: true, reason: 'no distraction candidate' };

      const timeline = buildTimeline(deps, ctx.firedAt);
      const current: CurrentDwell = {
        app: candidate.app,
        title: candidate.title,
        dwellMin: Math.round(candidate.dwellMs / MINUTE_MS),
      };

      const base = {
        app_name: candidate.app,
        dwell_started_at: candidate.runStart,
        window_title: candidate.title,
        evaluated_at: ctx.firedAt,
        eval_dwell_ms: candidate.dwellMs,
      };

      let verdict: JudgeResult;
      try {
        verdict = await judge(timeline, current, ctx.signal);
      } catch (err) {
        // Never publish on a judge failure. Record verdict='error' with the
        // dwell length so the filter (§2.6) defers the retry by REEVAL_MIN
        // instead of waking the judge every tick.
        deps.evalStore.recordEval({ ...base, verdict: 'error' });
        const message = err instanceof Error ? err.message : String(err);
        return { skip: true, reason: `judge failed: ${message}` };
      }

      const shouldPing =
        verdict.verdict === 'distracted' && verdict.confidence >= deps.confidencePct;

      if (!shouldPing) {
        // Record the verdict so the filter does not re-wake the judge for this
        // dwell until it grows or the title flips (§2.6).
        deps.evalStore.recordEval({
          ...base,
          verdict: verdict.verdict,
          confidence: verdict.confidence,
        });
        return {
          skip: true,
          reason: `verdict=${verdict.verdict} confidence=${verdict.confidence}`,
        };
      }

      const nudge = buildDistractionNudge({
        app: candidate.app,
        title: candidate.title,
        dwellMin: current.dwellMin,
        workSummary: verdict.work_summary,
        runStart: candidate.runStart,
        snoozeMin: deps.snoozeMin ?? DEFAULT_SNOOZE_MIN,
      });

      return {
        publish: true,
        content: nudge.content,
        components: nudge.components,
        onPublished: () => {
          deps.evalStore.recordEval({
            ...base,
            verdict: 'distracted',
            confidence: verdict.confidence,
            pinged: true,
          });
        },
      };
    },
  };
}
