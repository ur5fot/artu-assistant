# Multilingual PII Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Russian and Ukrainian PII detection via a custom Presidio Docker image with spaCy models for en/ru/uk, and update the server to analyze text in all configured languages in parallel.

**Architecture:** Build a custom `presidio-analyzer` image extending the official one with ru/uk spaCy models and a multi-language NLP config. Server sends parallel `/analyze` requests (one per language) and deduplicates overlapping results.

**Tech Stack:** Docker, Presidio Analyzer, spaCy (en_core_web_sm, ru_core_news_sm, uk_core_news_sm), TypeScript, Vitest.

---

### Task 1: Create custom Presidio Docker image

**Files:**
- Create: `presidio/Dockerfile`
- Create: `presidio/multilang.yaml`

- [ ] **Step 1: Create presidio directory**

Run: `mkdir -p /Users/dim/code/R2-D2/presidio`

- [ ] **Step 2: Write Dockerfile**

Create `/Users/dim/code/R2-D2/presidio/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/presidio-analyzer:2.2.355

RUN pip install --no-cache-dir \
    https://github.com/explosion/spacy-models/releases/download/ru_core_news_sm-3.7.0/ru_core_news_sm-3.7.0.tar.gz \
    https://github.com/explosion/spacy-models/releases/download/uk_core_news_sm-3.7.0/uk_core_news_sm-3.7.0.tar.gz

COPY multilang.yaml /usr/bin/presidio-analyzer/conf/default.yaml
```

- [ ] **Step 3: Write multilang.yaml**

Create `/Users/dim/code/R2-D2/presidio/multilang.yaml`:

```yaml
nlp_engine_name: spacy
models:
  - lang_code: en
    model_name: en_core_web_sm
  - lang_code: ru
    model_name: ru_core_news_sm
  - lang_code: uk
    model_name: uk_core_news_sm
```

- [ ] **Step 4: Commit**

```bash
cd /Users/dim/code/R2-D2
git add presidio/Dockerfile presidio/multilang.yaml
git commit -m "feat: add custom Presidio analyzer Dockerfile with ru/uk spaCy models"
```

---

### Task 2: Update docker-compose.yml to build analyzer locally

**Files:**
- Modify: `docker-compose.yml:13-18`

- [ ] **Step 1: Replace image with build**

In `/Users/dim/code/R2-D2/docker-compose.yml`, replace lines 13-18:

```yaml
  presidio-analyzer:
    build: ./presidio
    container_name: r2-presidio-analyzer
    ports:
      - "127.0.0.1:5002:3000"
    restart: unless-stopped
```

Keep `presidio-anonymizer` unchanged.

- [ ] **Step 2: Build the new image**

Run: `cd /Users/dim/code/R2-D2 && docker compose build presidio-analyzer`
Expected: Build completes successfully (may take 3-5 minutes for spaCy model downloads)

- [ ] **Step 3: Start analyzer and verify all three languages are loaded**

Run: `cd /Users/dim/code/R2-D2 && docker compose up -d presidio-analyzer && sleep 10 && curl -s -X POST http://localhost:5002/analyze -H "Content-Type: application/json" -d '{"text":"Меня зовут Дима","language":"ru","entities":["PERSON"]}'`
Expected: JSON response with PERSON entity found, not an error about language not supported.

Run: `curl -s -X POST http://localhost:5002/analyze -H "Content-Type: application/json" -d '{"text":"Мене звати Діма","language":"uk","entities":["PERSON"]}'`
Expected: JSON response with PERSON entity found.

Run: `curl -s -X POST http://localhost:5002/analyze -H "Content-Type: application/json" -d '{"text":"My name is Dima","language":"en","entities":["PERSON"]}'`
Expected: JSON response with PERSON entity found.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: build custom multilingual Presidio analyzer locally"
```

---

### Task 3: Update PresidioClient to accept languages

**Files:**
- Modify: `packages/server/src/pii/presidio.ts`
- Modify: `packages/server/src/pii/presidio.test.ts`

- [ ] **Step 1: Write failing test for multi-language analyze**

Replace the test file content of `/Users/dim/code/R2-D2/packages/server/src/pii/presidio.test.ts` with:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresidioClient } from './presidio.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PresidioClient', () => {
  let client: PresidioClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new PresidioClient({
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
      languages: ['en'],
    });
  });

  it('calls analyzer once per language and returns detected entities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
      ],
    });

    const results = await client.analyze('My email is john@example.com');
    expect(results).toEqual([
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:5002/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'My email is john@example.com',
        language: 'en',
        entities: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it('sends parallel requests for multiple languages and merges results', async () => {
    const multiClient = new PresidioClient({
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['PERSON', 'EMAIL_ADDRESS'],
      languages: ['en', 'ru', 'uk'],
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 20, end: 35, score: 0.95 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'PERSON', start: 7, end: 11, score: 0.85 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

    const results = await multiClient.analyze('Привет Дима, dima@example.com');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(results).toEqual(
      expect.arrayContaining([
        { entity_type: 'EMAIL_ADDRESS', start: 20, end: 35, score: 0.95 },
        { entity_type: 'PERSON', start: 7, end: 11, score: 0.85 },
      ]),
    );
  });

  it('deduplicates overlapping entities keeping the highest score', async () => {
    const multiClient = new PresidioClient({
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['PERSON'],
      languages: ['en', 'ru'],
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'PERSON', start: 0, end: 5, score: 0.9 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'PERSON', start: 0, end: 5, score: 0.7 },
        ],
      });

    const results = await multiClient.analyze('Dima test');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ entity_type: 'PERSON', start: 0, end: 5, score: 0.9 });
  });

  it('calls anonymizer with custom operators', async () => {
    const analyzerResults = [
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ];
    const operators = {
      EMAIL_ADDRESS: { type: 'replace', new_value: '<EMAIL:a7f3>' },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        text: 'My email is <EMAIL:a7f3>',
        items: [{ operator: 'replace', entity_type: 'EMAIL_ADDRESS', start: 12, end: 24, text: '<EMAIL:a7f3>' }],
      }),
    });

    const result = await client.anonymize('My email is john@example.com', analyzerResults, operators);
    expect(result.text).toBe('My email is <EMAIL:a7f3>');
  });

  it('throws on analyzer HTTP error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(client.analyze('test')).rejects.toThrow('Presidio analyzer error: 500');
  });

  it('throws if any language request fails', async () => {
    const multiClient = new PresidioClient({
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['PERSON'],
      languages: ['en', 'ru'],
    });

    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => [] })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'error' });

    await expect(multiClient.analyze('test')).rejects.toThrow('Presidio analyzer error: 500');
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(client.analyze('test')).rejects.toThrow('fetch failed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/pii/presidio.test.ts`
Expected: FAIL — tests reference `languages` field which doesn't exist yet.

- [ ] **Step 3: Update PresidioClient to accept and use languages**

Replace `/Users/dim/code/R2-D2/packages/server/src/pii/presidio.ts` with:

```typescript
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
}

const TIMEOUT_MS = 5000;

export class PresidioClient {
  private analyzerUrl: string;
  private anonymizerUrl: string;
  private entityTypes: string[];
  private languages: string[];

  constructor(config: PresidioClientConfig) {
    this.analyzerUrl = config.analyzerUrl;
    this.anonymizerUrl = config.anonymizerUrl;
    this.entityTypes = config.entityTypes;
    this.languages = config.languages;
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
        throw new Error(`Presidio analyzer error: ${res.status}`);
      }

      return res.json() as Promise<AnalyzerResult[]>;
    });

    const results = await Promise.all(requests);
    return dedupeByScore(results.flat());
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/pii/presidio.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/pii/presidio.ts packages/server/src/pii/presidio.test.ts
git commit -m "feat: PresidioClient supports parallel multi-language analyze"
```

---

### Task 4: Update PiiProxy config to pass languages

**Files:**
- Modify: `packages/server/src/pii/proxy.ts`
- Modify: `packages/server/src/pii/proxy.test.ts`

- [ ] **Step 1: Add languages to PiiProxyConfig**

In `/Users/dim/code/R2-D2/packages/server/src/pii/proxy.ts`, update the `PiiProxyConfig` interface and the `createPiiProxy` implementation:

```typescript
interface PiiProxyConfig {
  encryptionKey: string;
  analyzerUrl: string;
  anonymizerUrl: string;
  entityTypes: string[];
  languages: string[];
  mode: 'required' | 'optional';
}
```

And in `createPiiProxy`, update the PresidioClient instantiation (around line 26):

```typescript
  const presidio = new PresidioClient({
    analyzerUrl: config.analyzerUrl,
    anonymizerUrl: config.anonymizerUrl,
    entityTypes: config.entityTypes,
    languages: config.languages,
  });
```

- [ ] **Step 2: Update proxy.test.ts createPiiProxy call sites**

In `/Users/dim/code/R2-D2/packages/server/src/pii/proxy.test.ts`, add `languages: ['en']` to every `createPiiProxy({...})` call. There are 6 call sites at lines 44, 68, 91, 110, 129, 161. Each object literal needs an extra line:

```typescript
    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      languages: ['en'],
      mode: 'optional',
    });
```

Apply the `languages: ['en'],` addition to all 6 sites. Use Edit tool to add it after `entityTypes: [...],` on each config.

- [ ] **Step 3: Update integration.test.ts createPiiProxy call sites**

In `/Users/dim/code/R2-D2/packages/server/src/pii/integration.test.ts`, find all `createPiiProxy({...})` calls and add `languages: ['en'],` after `entityTypes: [...],` on each.

Run: `cd /Users/dim/code/R2-D2 && grep -n "createPiiProxy" packages/server/src/pii/integration.test.ts`
Expected: list of line numbers

Add `languages: ['en'],` to each config.

- [ ] **Step 4: Run PII tests**

Run: `cd /Users/dim/code/R2-D2 && npx vitest run packages/server/src/pii/`
Expected: PASS — all tests

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/pii/proxy.ts packages/server/src/pii/proxy.test.ts packages/server/src/pii/integration.test.ts
git commit -m "feat: PiiProxy accepts languages in config"
```

---

### Task 5: Wire PII_LANGUAGES env var in server index

**Files:**
- Modify: `packages/server/src/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Read PII_LANGUAGES env var and pass to createPiiProxy**

In `/Users/dim/code/R2-D2/packages/server/src/index.ts`, find the block starting at line 65 (where `entityTypes` is read) and update:

```typescript
  const entityTypes = (process.env.PII_ENTITY_TYPES || 'EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE').split(',');
  const languages = (process.env.PII_LANGUAGES || 'en,ru,uk').split(',').map((s) => s.trim()).filter(Boolean);
  piiProxy = createPiiProxy({
    encryptionKey,
    analyzerUrl: process.env.PRESIDIO_ANALYZER_URL || 'http://localhost:5002',
    anonymizerUrl: process.env.PRESIDIO_ANONYMIZER_URL || 'http://localhost:5001',
    entityTypes,
    languages,
    mode: piiMode,
  });
```

- [ ] **Step 2: Update .env.example**

In `/Users/dim/code/R2-D2/.env.example`, add a new line after `PII_ENTITY_TYPES=...`:

```
# Comma-separated list of languages for PII detection.
# Each language adds one analyzer HTTP call per anonymization request.
# Requires the custom Presidio image with spaCy models for ru/uk (see presidio/Dockerfile).
PII_LANGUAGES=en,ru,uk
```

Place it in the PII section, near `PII_ENTITY_TYPES`.

- [ ] **Step 3: Build server**

Run: `cd /Users/dim/code/R2-D2 && npm run build -w packages/server`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/index.ts .env.example
git commit -m "feat: read PII_LANGUAGES env var for multi-language analysis"
```

---

### Task 6: End-to-end smoke test

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `cd /Users/dim/code/R2-D2 && npm run build`
Expected: PASS — all packages compile

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/dim/code/R2-D2 && npm test`
Expected: All tests pass

- [ ] **Step 3: Start services and verify multilingual PII detection**

Run: `cd /Users/dim/code/R2-D2 && docker compose up -d presidio-analyzer presidio-anonymizer`

Wait ~15 seconds for analyzer to warm up, then test each language:

Run: `curl -s -X POST http://localhost:5002/analyze -H "Content-Type: application/json" -d '{"text":"Меня зовут Дима, мой email dima@test.com","language":"ru","entities":["PERSON","EMAIL_ADDRESS"]}' | python3 -m json.tool`
Expected: Array with at least EMAIL_ADDRESS entity; may also include PERSON (Дима)

Run: `curl -s -X POST http://localhost:5002/analyze -H "Content-Type: application/json" -d '{"text":"Мене звати Діма","language":"uk","entities":["PERSON"]}' | python3 -m json.tool`
Expected: Array, may include PERSON entity

- [ ] **Step 4: Start server and test mixed-language chat**

Run: `cd /Users/dim/code/R2-D2 && npm run dev`

In the chat UI, send a mixed-language message like:
```
Привіт, я Діма, мій email test@example.com
```

Verify:
- The `pii_masked` badge appears
- Email is masked (EMAIL_ADDRESS from en engine)
- If PERSON detection works for Ukrainian spaCy model, Діма is also masked

- [ ] **Step 5: Update AGENTS.md documentation**

In `/Users/dim/code/R2-D2/AGENTS.md`, add a note about the custom Presidio image.

Find the section about Presidio/PII (search for "Presidio"), and add:

```markdown
### Multilingual PII Detection

Presidio analyzer is built from a custom Docker image in `presidio/` with spaCy models for en, ru, and uk. Controlled via:
- `PII_LANGUAGES=en,ru,uk` — which languages to query (each is one parallel HTTP call)
- `presidio/Dockerfile` — base image version and spaCy model versions
- `presidio/multilang.yaml` — NLP engine configuration loaded by Presidio at startup

First `docker compose up` takes longer because the analyzer image builds locally (~3-5 min).
```

- [ ] **Step 6: Commit final docs**

```bash
git add AGENTS.md
git commit -m "docs: document multilingual PII setup in AGENTS.md"
```
