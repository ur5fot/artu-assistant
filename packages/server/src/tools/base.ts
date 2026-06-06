import type { ToolDefinition as SharedToolDefinition, SSEEvent } from '@r2/shared';
import type { PiiProxy } from '../pii/proxy.js';
import type { ClaudeClient } from '../ai/claude.js';
import type { ToolRegistry } from './registry.js';
import type { PendingConfirms } from '../routes/confirm.js';
import type { PendingPlanReviews } from '../routes/plan-review.js';
import type { PendingMemoryConfirms } from '../routes/memory-confirm.js';
import type { MemoryService } from '../memory/service.js';
import type { ReminderStore } from '../reminders/store.js';
import type { EmailStore } from '../emails/store.js';
import type { ImapAccount, NewMessage, FullMessage } from '../emails/types.js';
import type { Coords, Forecast, GeocodeResult } from '../weather/types.js';
import type { WindowHistoryStore } from '../observers/window-history-store.js';
import type { DistractionEvalStore } from '../observers/distraction-eval-store.js';

export type { ToolDefinition, ToolContext, PlanReviewResponse } from '@r2/shared';

export interface ImapClient {
  fetchNewMessages: (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
  fetchFullBody: (account: ImapAccount, uid: number) => Promise<FullMessage>;
  getAccount: (id: string) => ImapAccount | null;
}

// Minimal Open-Meteo client surface handed to @r2/tool-weather. Structurally
// compatible with that package's local `WeatherClientLike`; defined here (not
// imported) so the server never depends on a tool package's types.
export interface WeatherClientForTool {
  tz: string;
  fetchForecast: (lat: number, lon: number, tz: string, days?: number) => Promise<Forecast>;
  geocode: (name: string) => Promise<GeocodeResult | null>;
  formatBriefOutlook: (forecast: Forecast) => string;
  wmoToRu: (code: number) => string;
}

/** Resolve the user's cached coordinates (geocode-on-first-use). */
export type ResolveUserCoordsFn = () => Promise<Coords | null>;

export function toClaudeTool(tool: SharedToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

export interface RunLoopParams {
  messages: Array<{ role: 'user' | 'assistant'; content: string }> | any;
  onEvent: (event: SSEEvent) => void;
  signal?: AbortSignal;
  pendingConfirms?: PendingConfirms;
  pendingPlanReviews?: PendingPlanReviews;
  pendingMemoryConfirms?: PendingMemoryConfirms;
}

export type RunLoopFn = (params: RunLoopParams) => Promise<void>;

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService | null;
  reminderStore: ReminderStore | null;
  emailStore: EmailStore | null;
  imapClient: ImapClient | null;
  // Injected under WEATHER_ENABLED; null → the `weather` tool reports the
  // integration is not enabled.
  weatherClient: WeatherClientForTool | null;
  resolveUserCoords: ResolveUserCoordsFn | null;
  // Read by @r2/tool-activity (structurally as ActivityStoreLike/EvalStoreLike).
  // Injected under WINDOW_LOGGER_ENABLED; null store → the `activity` tool
  // reports the digital observer is disabled.
  store: WindowHistoryStore | null;
  evalStore: DistractionEvalStore | null;
}

export type ToolFactory = (deps: ToolDeps) => SharedToolDefinition | SharedToolDefinition[];
