import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDefinition } from '@r2/shared';
import type { Handler } from '../types.js';
import type { PiiProxy } from '../../pii/proxy.js';
import type { OllamaClient } from '../../ai/ollama.js';
import type { BriefWeatherDeps } from './morningBrief.helpers.js';
import type { TopicStore } from '../../topics/store.js';
import { buildPendingActionsComponents } from '../../channels/discord/embeds.js';
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
  // Injected under WEATHER_ENABLED; null → brief omits the forecast section.
  weather?: BriefWeatherDeps | null;
  // Source of open pending actions surfaced as "✓ Готово" buttons. Optional so
  // trigger-only tests can omit it; null/absent → brief never shows action buttons.
  topicStore?: Pick<TopicStore, 'getOpenActions'> | null;
}

export function createMorningBriefHandler(deps: Deps): Handler {
  const {
    piiProxy,
    anthropic,
    ollama = null,
    webSearchTool = null,
    weather = null,
    topicStore = null,
  } = deps;
  return {
    name: 'morningBrief',
    async trigger(state, ctx) {
      // Guard: a successful publish today blocks re-firing across both branches.
      // Errors and skips fall through to retry on the next tick.
      // NOTE: this self-gate is intentionally keyed on the publish OUTCOME, not
      // on actual delivery (published_at). If a brief generated but failed to
      // deliver (Discord down), redelivery (flushUndeliveredPushes on reconnect)
      // re-sends the existing payload — we must NOT regenerate it here, which a
      // delivery-keyed gate would do and would race the redelivery into a dup.
      // The email-digest morning-hold gate (morningBriefPublishedToday) keys on
      // published_at instead, since it only needs to know the user saw a brief.
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
        const data = await gatherData(ctx.db, ctx.firedAt, TZ, weather, topicStore);
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
        // One "✓ Готово" button per open action (capped); none → omit components
        // entirely so the brief stays a plain text DM exactly as before.
        const components = buildPendingActionsComponents(data.openActions ?? []);
        return components.length > 0
          ? { publish: true, content: text, components }
          : { publish: true, content: text };
      } catch (err) {
        return {
          error: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
