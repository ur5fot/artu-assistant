import type Database from 'better-sqlite3';

// Plain-data shapes for rich messages — kept free of discord.js so handlers
// in the cognition layer can describe embeds/buttons without coupling to the
// channel implementation. bot.ts converts these to ActionRowBuilder /
// EmbedBuilder at the boundary.
export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';

export interface ButtonData {
  customId: string;
  label: string;
  style: ButtonStyle;
  emoji?: string;
}

export interface SelectOptionData {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
}

export interface SelectMenuData {
  customId: string;
  placeholder?: string;
  options: SelectOptionData[];
}

export type ComponentData =
  | { type: 'row'; buttons: ButtonData[] }
  | { type: 'select'; menu: SelectMenuData };

// Narrow a component (or nothing) to its button list — '' for select/empty rows.
// Keeps callers free of inline discriminant checks now that ComponentData is a
// union; used by handler/embed tests and any consumer that only cares about
// button rows.
export function buttonsOf(c: ComponentData | undefined | null): ButtonData[] {
  return c && c.type === 'row' ? c.buttons : [];
}

export interface EmbedFieldData {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedData {
  title?: string;
  description?: string;
  fields?: EmbedFieldData[];
  footer?: string;
}

// `onPublished` fires after the publish channel (Discord DM today) confirms a
// successful send — use it for state transitions that must not happen when the
// push fails silently (e.g., marking email_pending rows delivered only after
// the user actually received the digest, so a Discord outage does not drop
// those rows from the next digest run).
export type HandlerResult =
  | {
      publish: true;
      content: string;
      embed?: EmbedData;
      components?: ComponentData[];
      onPublished?: () => void | Promise<void>;
    }
  | { skip: true; reason: string }
  | { error: true; message: string };

export interface HandlerState {
  now: number;
  lastFiredAt: number | null;
  lastResult: HandlerResult | null;
}

export interface HandlerContext {
  db: Database.Database;
  signal: AbortSignal;
  // Epoch ms captured when the worker popped this job off the queue. Handlers
  // that are sensitive to day boundaries (e.g., morningBrief) must use this
  // instead of calling Date.now() themselves: trigger and run run at different
  // wall-clock instants, so a fresh Date.now() in run can fall on a later
  // local day than trigger intended — producing a brief for a day that has
  // only a few seconds of data.
  firedAt: number;
}

export interface TriggerContext {
  db: Database.Database;
}

export interface Handler {
  name: string;
  trigger: (state: HandlerState, ctx: TriggerContext) => boolean | Promise<boolean>;
  run: (ctx: HandlerContext) => Promise<HandlerResult>;
}

export interface HandlerRunRecord {
  id: number;
  handlerName: string;
  firedAt: number;
  durationMs: number;
  outcome: 'publish' | 'skip' | 'error';
  content?: string;
  reason?: string;
  publishedAt?: number;
}

export interface CognitionStatus {
  paused: boolean;
  lastTickAt: number | null;
  ticks24h: number;
  queueSize: number;
  handlers: string[];
  recentRuns: HandlerRunRecord[];
}
