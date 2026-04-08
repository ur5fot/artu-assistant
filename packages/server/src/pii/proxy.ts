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

const TOKEN_REGEX = /<([A-Z]+):([a-f0-9]{8})>/g;

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

      // Build tokens for each detected entity and do local string replacement
      const entities: Array<{ type: string; token: string }> = [];

      // Sort by start position descending so replacements don't shift earlier offsets
      const sorted = [...analyzerResults].sort((a, b) => b.start - a.start);
      let anonymized = text;

      for (const result of sorted) {
        const originalValue = text.slice(result.start, result.end);
        const token = vault.makeToken(originalValue, result.entity_type);
        vault.store(token, originalValue, result.entity_type);
        anonymized = anonymized.slice(0, result.start) + token + anonymized.slice(result.end);
        entities.push({ type: result.entity_type, token });
      }

      return { text: anonymized, entities };
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
