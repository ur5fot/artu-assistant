import type { EmbeddingsClient } from './embeddings.js';

const VOYAGE_DIMENSIONS: Record<string, number> = {
  'voyage-3': 1024,
  'voyage-3-large': 1024,
};

const EMBED_INPUT_MAX_CHARS = 8000;
const CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;

interface VoyageConfig {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  retryBackoffMs?: number;
}

interface VoyageResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export function createVoyageEmbeddingsClient(config: VoyageConfig): EmbeddingsClient {
  const dimension = VOYAGE_DIMENSIONS[config.model];
  if (!dimension) {
    throw new Error(
      `Unsupported VOYAGE_MODEL: ${config.model}. Supported: ${Object.keys(VOYAGE_DIMENSIONS).join(', ')}`,
    );
  }
  if (!config.apiKey) {
    throw new Error('VOYAGE_API_KEY required for Voyage embeddings client');
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const baseBackoff = config.retryBackoffMs ?? DEFAULT_BACKOFF_MS;
  let circuitOpenedAt = 0;

  async function callVoyage(
    text: string,
    inputType: 'document' | 'query',
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (circuitOpenedAt && Date.now() - circuitOpenedAt < CIRCUIT_OPEN_MS) {
      throw new Error('Voyage circuit open (recent failure)');
    }
    circuitOpenedAt = 0;

    const input = text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: [input], model: config.model, input_type: inputType }),
          signal: combinedSignal,
        });

        if (res.status === 401) {
          await res.body?.cancel().catch(() => {});
          throw new Error('Voyage auth failed (401) — check VOYAGE_API_KEY');
        }

        if (res.status === 429) {
          await res.body?.cancel().catch(() => {});
          lastErr = new Error('Voyage rate limit (429)');
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, baseBackoff * 2 ** attempt));
            continue;
          }
          throw lastErr;
        }

        // Retry transient upstream failures (502/503/504 during Voyage
        // maintenance or overload) with the same backoff as 429. Without this,
        // a single 5xx trips the circuit breaker and blocks all memory ops for
        // CIRCUIT_OPEN_MS even when the upstream recovers immediately.
        if (res.status >= 500 && res.status < 600) {
          await res.body?.cancel().catch(() => {});
          lastErr = new Error(`Voyage error ${res.status}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, baseBackoff * 2 ** attempt));
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          // Surface body content so operators can diagnose 400-class errors
          // (bad model name, malformed input, quota). cancel() loses the body.
          let bodySnippet = '';
          try {
            const text = typeof res.text === 'function' ? await res.text() : '';
            if (text) bodySnippet = `: ${text.slice(0, 200)}`;
          } catch {
            await res.body?.cancel().catch(() => {});
          }
          throw new Error(`Voyage error ${res.status}${bodySnippet}`);
        }

        const data = (await res.json()) as VoyageResponse;
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) {
          throw new Error('Voyage response missing embedding');
        }
        if (embedding.length !== dimension) {
          throw new Error(
            `Voyage dimension mismatch: model '${config.model}' returned ${embedding.length}, expected ${dimension}`,
          );
        }
        for (const n of embedding) {
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            throw new Error('Voyage response contains non-finite values');
          }
        }
        return embedding;
      } catch (err) {
        const abortedByCaller = signal?.aborted === true;
        // Auth failures are not transient — a bad key won't recover in 30s.
        // Opening the circuit on 401 hides the real cause behind a generic
        // "circuit open" message on every subsequent call.
        const isAuthError = err instanceof Error && err.message.includes('auth failed (401)');
        if (!abortedByCaller && !isAuthError) {
          circuitOpenedAt = Date.now();
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('Voyage request failed');
  }

  return {
    dimension,
    identity: `voyage:${config.model}`,
    embedDocument: (text, signal) => callVoyage(text, 'document', signal),
    embedQuery: (text, signal) => callVoyage(text, 'query', signal),
  };
}
