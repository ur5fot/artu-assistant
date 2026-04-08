import { PresidioClient, type AnalyzerResult } from './presidio.js';
import { PiiVault } from './vault.js';

export interface AnonymizeResult {
  text: string;
  entities: Array<{ type: string; token: string }>;
}

export interface PiiProxy {
  anonymize(text: string): Promise<AnonymizeResult>;
  deanonymize(text: string): Promise<string>;
}

interface PiiProxyConfig {
  encryptionKey: string;
  analyzerUrl: string;
  anonymizerUrl: string;
  entityTypes: string[];
  mode: 'required' | 'optional';
}

const TOKEN_REGEX = /<([A-Z]+):([a-f0-9]{4})>/g;

export function createPiiProxy(config: PiiProxyConfig): PiiProxy {
  const vault = new PiiVault(config.encryptionKey);
  const presidio = new PresidioClient({
    analyzerUrl: config.analyzerUrl,
    anonymizerUrl: config.anonymizerUrl,
    entityTypes: config.entityTypes,
  });

  return {
    async anonymize(text: string): Promise<AnonymizeResult> {
      let analyzerResults: AnalyzerResult[];
      try {
        analyzerResults = await presidio.analyze(text);
      } catch (err) {
        if (config.mode === 'optional') {
          console.warn('PII analyzer unavailable, passing through:', err instanceof Error ? err.message : err);
          return { text, entities: [] };
        }
        throw err;
      }

      if (analyzerResults.length === 0) {
        return { text, entities: [] };
      }

      // Build operators: for each detected entity, generate a token and store in vault
      const operators: Record<string, { type: string; new_value: string }> = {};
      const entities: Array<{ type: string; token: string }> = [];

      for (const result of analyzerResults) {
        const originalValue = text.slice(result.start, result.end);
        const token = vault.makeToken(originalValue, result.entity_type);
        vault.store(token, originalValue, result.entity_type);

        operators[result.entity_type] = {
          type: 'replace',
          new_value: token,
        };
        entities.push({ type: result.entity_type, token });
      }

      try {
        const anonymized = await presidio.anonymize(text, analyzerResults, operators);
        return { text: anonymized.text, entities };
      } catch (err) {
        if (config.mode === 'optional') {
          console.warn('PII anonymizer unavailable, passing through:', err instanceof Error ? err.message : err);
          return { text, entities: [] };
        }
        throw err;
      }
    },

    async deanonymize(text: string): Promise<string> {
      return text.replace(TOKEN_REGEX, (match) => {
        const original = vault.retrieve(match);
        return original ?? match;
      });
    },
  };
}

export function createPassthroughProxy(): PiiProxy {
  return {
    async anonymize(text: string): Promise<AnonymizeResult> {
      return { text, entities: [] };
    },
    async deanonymize(text: string): Promise<string> {
      return text;
    },
  };
}
