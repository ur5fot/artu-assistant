export interface EmbeddingsClient {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

interface EmbeddingsClientConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

const EMBED_INPUT_MAX_CHARS = 8000;

// Must match FLOAT[768] in db.ts memory_vec_* virtual tables. If a user
// points MEMORY_EMBED_MODEL at a model with a different output dimension,
// inserts fail deep inside sqlite-vec with an opaque error and search
// degrades silently via the warn-and-continue paths. Fail loudly instead.
const EXPECTED_EMBED_DIM = 768;

// Circuit breaker: if Ollama is unreachable, stop hammering it. Without this,
// a single chat turn can stack three 15s timeouts (router prefix embed, ollama
// chat, claude-fallback prefix embed) and block the user for ~45s before any
// response. After a failure we refuse new embed calls for a cool-down window.
const CIRCUIT_OPEN_MS = 30_000;

export function createEmbeddingsClient(config: EmbeddingsClientConfig): EmbeddingsClient {
  const timeoutMs = config.timeoutMs ?? 15000;
  let openedAt = 0;
  return {
    async embed(text: string, signal?: AbortSignal): Promise<number[]> {
      if (openedAt && Date.now() - openedAt < CIRCUIT_OPEN_MS) {
        throw new Error('Embeddings circuit open (recent failure)');
      }
      openedAt = 0;
      const input = text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;
      // Combine caller cancellation with the timeout so a disconnected client
      // does not keep the fetch alive for up to timeoutMs.
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const res = await fetch(`${config.url}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, prompt: input }),
          signal: combinedSignal,
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Embeddings error ${res.status}`);
        }
        const data = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(data.embedding)) {
          throw new Error('Embeddings response missing embedding');
        }
        if (data.embedding.length !== EXPECTED_EMBED_DIM) {
          throw new Error(
            `Embeddings dimension mismatch: model '${config.model}' returned ${data.embedding.length}, expected ${EXPECTED_EMBED_DIM}. ` +
              `The memory_vec_* tables are defined as FLOAT[${EXPECTED_EMBED_DIM}]; change MEMORY_EMBED_MODEL back to a 768-dim model or rebuild the schema.`,
          );
        }
        for (const n of data.embedding) {
          if (typeof n !== 'number' || !Number.isFinite(n)) {
            throw new Error('Embeddings response contains non-finite values');
          }
        }
        return data.embedding;
      } catch (err) {
        // A caller-initiated abort is not a server health signal — don't open
        // the circuit, or the next request would be refused for no reason.
        const abortedByCaller = signal?.aborted === true;
        if (!abortedByCaller) {
          openedAt = Date.now();
        }
        throw err;
      }
    },
  };
}
