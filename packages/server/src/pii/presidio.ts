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
}

const TIMEOUT_MS = 5000;

export class PresidioClient {
  private analyzerUrl: string;
  private anonymizerUrl: string;
  private entityTypes: string[];

  constructor(config: PresidioClientConfig) {
    this.analyzerUrl = config.analyzerUrl;
    this.anonymizerUrl = config.anonymizerUrl;
    this.entityTypes = config.entityTypes;
  }

  async analyze(text: string): Promise<AnalyzerResult[]> {
    const res = await fetch(`${this.analyzerUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language: 'en',
        entities: this.entityTypes,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Presidio analyzer error: ${res.status}`);
    }

    return res.json();
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
