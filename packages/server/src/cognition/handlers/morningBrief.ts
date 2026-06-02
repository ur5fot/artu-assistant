import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from '@r2/shared';
import type { Handler } from '../types.js';
import type { PiiProxy } from '../../pii/proxy.js';
import type { OllamaClient } from '../../ai/ollama.js';
import {
  composePrompt,
  gatherData,
  hasUserActivitySince,
  hasUserActivityInLastHour,
  hasWindowActivitySince,
  isSameLocalDate,
  getLocalCivilEpoch,
  getLastBriefPublishAt,
  computeGapDays,
  GAP_MODE_THRESHOLD,
} from './morningBrief.helpers.js';
import { callMorningBriefAI } from './morningBrief.ai.js';

const TZ = 'Europe/Kyiv';
const ACTIVITY_START_HOUR = 6;

interface Deps {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
  ollama?: OllamaClient | null;
  webSearchTool?: ToolDefinition | null;
}

export function createMorningBriefHandler(deps: Deps): Handler {
  const { piiProxy, anthropic, ollama = null, webSearchTool = null } = deps;
  return {
    name: 'morningBrief',
    async trigger(state, ctx) {
      // Guard: a successful publish today blocks re-firing across both branches.
      // Errors and skips fall through to retry on the next tick.
      const publishedToday =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        isSameLocalDate(state.lastFiredAt, state.now, TZ);
      if (publishedToday) return false;

      // Branch A — morning window: fire at/after 06:00 local with any activity
      // since 06:00 today. DST-aware civil time avoids drift on transition days.
      // Activity = a chat message OR a window session starting (user sat down at
      // the Mac) — earliest-wins. Chat is checked first so a real message
      // short-circuits the extra window query.
      const sixAmLocal = getLocalCivilEpoch(state.now, TZ, 0, ACTIVITY_START_HOUR);
      if (
        state.now >= sixAmLocal &&
        (hasUserActivitySince(ctx.db, sixAmLocal, state.now) ||
          hasWindowActivitySince(ctx.db, sixAmLocal, state.now))
      ) {
        return true;
      }

      // Branch B — gap-return: catch the user's first activity after a gap of
      // GAP_MODE_THRESHOLD or more local days. Last-hour gate (chat OR window
      // session start) avoids firing on stale activity; chat checked first.
      const lastPublishAt = getLastBriefPublishAt(ctx.db);
      const gapDays = computeGapDays(lastPublishAt, state.now, TZ);
      if (
        gapDays >= GAP_MODE_THRESHOLD &&
        (hasUserActivityInLastHour(ctx.db, state.now) ||
          hasWindowActivitySince(ctx.db, state.now - 3600_000, state.now))
      ) {
        return true;
      }

      return false;
    },
    async run(ctx) {
      try {
        const data = gatherData(ctx.db, ctx.firedAt, TZ);
        const prompt = composePrompt(data, TZ);
        const text = await callMorningBriefAI({
          piiProxy,
          anthropic,
          ollama,
          prompt,
          signal: ctx.signal,
          webSearchTool,
        });
        if (!text.trim()) return { skip: true, reason: 'empty AI response' };
        return { publish: true, content: text };
      } catch (err) {
        return {
          error: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
