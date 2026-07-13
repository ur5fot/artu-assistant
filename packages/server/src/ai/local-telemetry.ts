import type { LocalDomain } from './local-route.js';

export interface LocalRouteTelemetry {
  provider: 'ollama' | 'claude';
  routeReason: string;
  domain: LocalDomain | null;
  tools: string[];
  estimatedPromptTokens?: number;
  latencyMs: number;
  fallbackReason?: string;
}

export function logLocalRoute(event: LocalRouteTelemetry): void {
  console.info('[local-route]', JSON.stringify({ event: 'local_route', ...event }));
}
