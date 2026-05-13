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

// Marks errors that are deterministic from the response and should not retry
// (4xx non-auth, malformed/empty body, dimension mismatch, non-finite values).
// Without this, the catch block would retry up to MAX_RETRIES times on a
// fundamentally broken response and waste API calls before opening the circuit.
const PERMANENT = Symbol('voyagePermanentError');
function permanent(err: Error): Error {
  (err as Error & { [PERMANENT]?: boolean })[PERMANENT] = true;
  return err;
}
function isPermanent(err: unknown): boolean {
  return err instanceof Error && (err as Error & { [PERMANENT]?: boolean })[PERMANENT] === true;
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

  // Sleep that resolves immediately if the caller aborts. Plain setTimeout in
  // the retry path would stall an aborted Discord turn for the full backoff
  // window (~3s across 1s+2s on the second retry) before the next fetch can
  // observe the abort. We still resolve (not reject) so the loop hits its
  // next iteration where the combined AbortSignal triggers the proper abort
  // path inside fetch — keeps the abort-handling logic in one place.
  function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

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
            await sleepUnlessAborted(baseBackoff * 2 ** attempt, signal);
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
            await sleepUnlessAborted(baseBackoff * 2 ** attempt, signal);
            continue;
          }
          throw lastErr;
        }

        if (!res.ok) {
          // Drain body without echoing it. Voyage 4xx responses commonly
          // reflect a fragment of the original input back in the error message;
          // memory pipeline indexes raw, non-anonymized user content, so
          // surfacing that body to console.warn (see service.ts safeEmbed*)
          // would expose PII (emails, phone numbers, etc.) to operator logs.
          await res.body?.cancel().catch(() => {});
          throw permanent(new Error(`Voyage error ${res.status}`));
        }

        const data = (await res.json()) as VoyageResponse;
        const embedding = data.data?.[0]?.embedding;
        if (!Array.isArray(embedding)) {
          throw permanent(new Error('Voyage response missing embedding'));
        }
        if (embedding.length !== dimension) {
          throw permanent(new Error(
            `Voyage dimension mismatch: model '${config.model}' returned ${embedding.length}, expected ${dimension}`,
          ));
        }
        for (const n of embedding) {
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            throw permanent(new Error('Voyage response contains non-finite values'));
          }
        }
        return embedding;
      } catch (err) {
        const abortedByCaller = signal?.aborted === true;
        // Auth failures are not transient — a bad key won't recover in 30s.
        // Opening the circuit on 401 hides the real cause behind a generic
        // "circuit open" message on every subsequent call.
        const isAuthError = err instanceof Error && err.message.includes('auth failed (401)');
        if (abortedByCaller || isAuthError) {
          throw err;
        }
        // Permanent errors (4xx, malformed response, dimension/value validation)
        // are deterministic — retrying wastes API calls. Open the circuit so
        // the next caller sees a fast "circuit open" instead of repeating the
        // same broken request.
        if (isPermanent(err)) {
          circuitOpenedAt = Date.now();
          throw err;
        }
        // Retry transient errors that escape the status-code paths above:
        // fetch network failures, timeouts (timeoutSignal firing throws AbortError).
        // Without this, a single transient timeout trips the circuit breaker and
        // blocks all memory ops for CIRCUIT_OPEN_MS even though the next call
        // would have succeeded.
        if (attempt < MAX_RETRIES - 1) {
          lastErr = err instanceof Error ? err : new Error(String(err));
          await sleepUnlessAborted(baseBackoff * 2 ** attempt, signal);
          continue;
        }
        circuitOpenedAt = Date.now();
        throw err;
      }
    }
    // Unreachable: every path in the loop body either returns or throws.
    throw lastErr ?? new Error('Voyage request failed');
  }

  return {
    dimension,
    identity: `voyage:${config.model}`,
    embedDocument: (text, signal) => callVoyage(text, 'document', signal),
    embedQuery: (text, signal) => callVoyage(text, 'query', signal),
  };
}
