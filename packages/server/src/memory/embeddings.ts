export interface EmbeddingsClient {
  embed(text: string): Promise<number[]>;
}

interface EmbeddingsClientConfig {
  url: string;
  model: string;
  timeoutMs?: number;
}

export function createEmbeddingsClient(config: EmbeddingsClientConfig): EmbeddingsClient {
  const timeoutMs = config.timeoutMs ?? 15000;
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(`${config.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: text }),
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
    },
  };
}
