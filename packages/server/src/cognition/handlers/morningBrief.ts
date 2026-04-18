import type Anthropic from '@anthropic-ai/sdk';
import type { Handler } from '../types.js';
import type { PiiProxy } from '../../pii/proxy.js';
import {
  composePrompt,
  gatherData,
  hasUserActivityToday,
  isSameLocalDate,
  getLocalCivilEpoch,
} from './morningBrief.helpers.js';
import { callMorningBriefAI } from './morningBrief.ai.js';

const TZ = 'Europe/Kyiv';
const ACTIVITY_START_HOUR = 6;

interface Deps {
  piiProxy: PiiProxy;
  anthropic: Anthropic;
}

export function createMorningBriefHandler(deps: Deps): Handler {
  const { piiProxy, anthropic } = deps;
  return {
    name: 'morningBrief',
    async trigger(state, ctx) {
      // DST-aware: resolves to civil 06:00 local even on transition days,
      // where naive `midnight + 6h` would drift to 05:00 or 07:00.
      const sixAmLocal = getLocalCivilEpoch(state.now, TZ, 0, ACTIVITY_START_HOUR);
      if (state.now < sixAmLocal) return false;
      // Only a successful publish today blocks re-firing.
      // Errors and skips should retry on the next tick.
      const publishedToday =
        state.lastResult !== null &&
        'publish' in state.lastResult &&
        state.lastResult.publish === true &&
        state.lastFiredAt !== null &&
        isSameLocalDate(state.lastFiredAt, state.now, TZ);
      if (publishedToday) return false;
      return hasUserActivityToday(ctx.db, state.now, TZ);
    },
    async run(ctx) {
      try {
        const data = gatherData(ctx.db, Date.now(), TZ);
        const prompt = composePrompt(data, TZ);
        const text = await callMorningBriefAI({
          piiProxy,
          anthropic,
          prompt,
          signal: ctx.signal,
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
