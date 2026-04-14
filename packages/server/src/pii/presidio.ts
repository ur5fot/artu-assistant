export interface AnalyzerResult {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface AnonymizerOperator {
  type: string;
  new_value: string;
}

export interface AnonymizerResult {
  text: string;
  items: Array<{
    operator: string;
    entity_type: string;
    start: number;
    end: number;
    text: string;
  }>;
}

interface PresidioClientConfig {
  analyzerUrl: string;
  anonymizerUrl: string;
  entityTypes: string[];
  languages: string[];
  partialFailure?: 'throw' | 'tolerate';
}

const TIMEOUT_MS = 5000;

export class PresidioClient {
  private analyzerUrl: string;
  private anonymizerUrl: string;
  private entityTypes: string[];
  private languages: string[];
  private partialFailure: 'throw' | 'tolerate';

  constructor(config: PresidioClientConfig) {
    if (config.languages.length === 0) {
      throw new Error('PresidioClient requires at least one language');
    }
    this.analyzerUrl = config.analyzerUrl;
    this.anonymizerUrl = config.anonymizerUrl;
    this.entityTypes = config.entityTypes;
    this.languages = config.languages;
    this.partialFailure = config.partialFailure ?? 'throw';
  }

  async analyze(text: string): Promise<AnalyzerResult[]> {
    const requests = this.languages.map(async (language) => {
      const res = await fetch(`${this.analyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          language,
          entities: this.entityTypes,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        // Presidio returns 500 with this message when the requested entity
        // types have no recognizers registered for the given language (e.g.
        // ru/uk lack the built-in EMAIL_ADDRESS/PHONE_NUMBER recognizers).
        // Treat that as an empty result for this language rather than failing
        // the whole multi-language analyze call.
        if (res.status === 500) {
          const body = await res.text().catch(() => '');
          if (body.includes('No matching recognizers')) {
            return [] as AnalyzerResult[];
          }
        }
        throw new Error(`Presidio analyzer error: ${res.status}`);
      }

      return res.json() as Promise<AnalyzerResult[]>;
    });

    const settled = await Promise.allSettled(requests);
    const fulfilled: AnalyzerResult[] = [];
    const rejections: unknown[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        fulfilled.push(...result.value);
      } else {
        rejections.push(result.reason);
        console.warn(
          `Presidio analyzer failed for language=${this.languages[i]}:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      }
    });
    const shouldThrow =
      rejections.length > 0 &&
      (this.partialFailure === 'throw' || rejections.length === this.languages.length);
    if (shouldThrow) {
      throw rejections[0] instanceof Error ? rejections[0] : new Error(String(rejections[0]));
    }
    return dedupeByScore(fulfilled);
  }

  async anonymize(
    text: string,
    analyzerResults: AnalyzerResult[],
    operators: Record<string, AnonymizerOperator>,
  ): Promise<AnonymizerResult> {
    const res = await fetch(`${this.anonymizerUrl}/anonymize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        analyzer_results: analyzerResults,
        operators,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Presidio anonymizer error: ${res.status}`);
    }

    return res.json();
  }
}

function dedupeByScore(results: AnalyzerResult[]): AnalyzerResult[] {
  const byKey = new Map<string, AnalyzerResult>();
  for (const r of results) {
    const key = `${r.entity_type}:${r.start}:${r.end}`;
    const existing = byKey.get(key);
    if (!existing || r.score > existing.score) {
      byKey.set(key, r);
    }
  }
  return [...byKey.values()];
}
