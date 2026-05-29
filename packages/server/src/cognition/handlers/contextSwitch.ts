import type { Handler } from '../types.js';
import type { WindowHistoryStore } from '../../observers/window-history-store.js';
import type { ContextPingStore, SwitchEvent } from '../../observers/context-switch-detector.js';
import { detectContextSwitch } from '../../observers/context-switch-detector.js';
import { buildWindowRestoreEmbed } from '../../channels/discord/embeds.js';

const MINUTE_MS = 60_000;

interface Deps {
  store: WindowHistoryStore;
  pingStore: ContextPingStore;
  longSessionMin: number;
  switchGapMin: number;
  stableNewMin: number;
  dedupeWindowH: number;
}

function detect(deps: Deps, now: number): SwitchEvent | null {
  return detectContextSwitch({
    now,
    store: deps.store,
    pingStore: deps.pingStore,
    longSessionMin: deps.longSessionMin,
    switchGapMin: deps.switchGapMin,
    stableNewMin: deps.stableNewMin,
    dedupeWindowH: deps.dedupeWindowH,
  });
}

export function createContextSwitchHandler(deps: Deps): Handler {
  return {
    name: 'contextSwitch',
    async trigger(state) {
      return detect(deps, state.now) !== null;
    },
    async run(ctx) {
      // Re-detect defensively — trigger and run execute at different instants,
      // and the detector reads live window history. A switch that was true at
      // trigger time may have aged out (or already been pinged) by now.
      const event = detect(deps, ctx.firedAt);
      if (event === null) return { skip: true, reason: 'no context switch' };

      const durationMin = Math.round(
        (event.away_session_ended_at - event.away_session_started_at) / MINUTE_MS,
      );
      const { embed, components } = buildWindowRestoreEmbed(event, durationMin);
      return {
        publish: true,
        content: `🔁 You're back at ${event.current_app} after ~${durationMin}min on ${event.away_app}`,
        embed,
        components,
        onPublished: () =>
          deps.pingStore.recordPing({
            away_app: event.away_app,
            away_session_started_at: event.away_session_started_at,
            away_session_ended_at: event.away_session_ended_at,
            pinged_at: Date.now(),
          }),
      };
    },
  };
}
