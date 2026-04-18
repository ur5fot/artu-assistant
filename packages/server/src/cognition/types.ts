import type Database from 'better-sqlite3';

export type HandlerResult =
  | { publish: true; content: string }
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
}

export interface Handler {
  name: string;
  trigger: (state: HandlerState) => boolean;
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
