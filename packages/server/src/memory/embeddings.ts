export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>;
}

interface EmbeddingsClientConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

const EMBED_INPUT_MAX_CHARS = 8000;

// Circuit breaker: if Ollama is unreachable, stop hammering it. Without this,
// a single chat turn can stack three 15s timeouts (router prefix embed, ollama
// chat, claude-fallback prefix embed) and block the user for ~45s before any
// response. After a failure we refuse new embed calls for a cool-down window.
const CIRCUIT_OPEN_MS = 30_000;

export function createEmbeddingsClient(config: EmbeddingsClientConfig): EmbeddingsClient {
  const timeoutMs = config.timeoutMs ?? 15000;
  let openedAt = 0;
  return {
    async embed(text: string): Promise<number[]> {
      if (openedAt && Date.now() - openedAt < CIRCUIT_OPEN_MS) {
        throw new Error('Embeddings circuit open (recent failure)');
      }
      openedAt = 0;
      const input = text.length > EMBED_INPUT_MAX_CHARS ? text.slice(0, EMBED_INPUT_MAX_CHARS) : text;
      try {
        const res = await fetch(`${config.url}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: config.model, prompt: input }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Embeddings error ${res.status}`);
        }
        const data = (await res.json()) as { embedding?: number[] };
        if (!Array.isArray(data.embedding)) {
          throw new Error('Embeddings response missing embedding');
        }
        return data.embedding;
      } catch (err) {
        openedAt = Date.now();
        throw err;
      }
    },
  };
}
