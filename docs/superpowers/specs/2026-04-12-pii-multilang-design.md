# Multilingual PII Detection (Russian + Ukrainian)

## Summary

Extend Presidio PII detection to support Russian and Ukrainian in addition to English. Builds a custom Presidio analyzer Docker image with spaCy models for all three languages, and updates the server to query all languages in parallel for each anonymization request.

## Problem

Currently `packages/server/src/pii/presidio.ts:49` hardcodes `language: 'en'` in the analyzer request. Presidio's default image only ships with the English spaCy model. Russian/Ukrainian user text — which is the primary language of this project — gets zero PII detection beyond regex-based entities (email, phone, IBAN), producing false negatives on PERSON and LOCATION entities written in Cyrillic.

## Approach

1. Build a custom Presidio analyzer Docker image with all three spaCy models installed
2. Update the server to send parallel analyze requests — one per language — and merge results
3. Make the language list configurable via env var

Presidio's `/analyze` endpoint accepts only one `language` parameter per request, so multi-language detection requires N HTTP calls per text. For 3 languages this means 3× load on the analyzer, mitigated by parallelism.

## 1. Custom Presidio Docker Image

### New directory: `presidio/`

Contains:
- `Dockerfile` — extends official Presidio analyzer with spaCy models
- `multilang.yaml` — NLP engine config declaring all three languages

### Dockerfile

```dockerfile
FROM mcr.microsoft.com/presidio-analyzer:2.2.355

RUN pip install --no-cache-dir \
    https://github.com/explosion/spacy-models/releases/download/ru_core_news_sm-3.7.0/ru_core_news_sm-3.7.0.tar.gz \
    https://github.com/explosion/spacy-models/releases/download/uk_core_news_sm-3.7.0/uk_core_news_sm-3.7.0.tar.gz

COPY multilang.yaml /usr/bin/presidio-analyzer/conf/default.yaml
```

The base image version is pinned (not `:latest`) so upgrades are deliberate. spaCy model versions are pinned to match the spaCy version shipped in Presidio 2.2.355.

### multilang.yaml

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

Presidio loads this config at startup, making all three NLP engines available. Each `/analyze` request still specifies a single language, but the server can now pick any of the three.

## 2. docker-compose.yml Changes

Replace the pulled image with a local build for `presidio-analyzer`:

```yaml
  presidio-analyzer:
    build: ./presidio
    ports:
      - '5002:3000'
```

The `presidio-anonymizer` service stays unchanged — it only masks text, language-agnostic.

## 3. Server Code Changes

### presidio.ts

The `PresidioClient.analyze()` method changes:
- Constructor accepts `languages: string[]` (defaulting to `['en']`)
- `analyze(text)` sends N parallel requests (one per language) and merges results
- When the same span is detected by multiple languages, keep the highest-score entity

```typescript
async analyze(text: string): Promise<AnalyzerResult[]> {
  const requests = this.languages.map(async (lang) => {
    const res = await fetch(`${this.analyzerUrl}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language: lang,
        entities: this.entityTypes,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Presidio analyze failed for ${lang}: ${res.status}`);
    }
    return res.json() as Promise<AnalyzerResult[]>;
  });

  const results = await Promise.all(requests);
  return dedupeByScore(results.flat());
}
```

`dedupeByScore()` removes duplicate spans (same `start`/`end`/`entity_type`) keeping the highest score. This ensures that if English detects "Dima" as PERSON and Ukrainian also detects it, we keep one entry.

### proxy.ts

`createPiiProxy()` accepts a new `languages` field in its config:

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

Passes `languages` to `new PresidioClient(...)`.

### index.ts

Read from env var:

```typescript
const languages = (process.env.PII_LANGUAGES || 'en,ru,uk').split(',').map((s) => s.trim()).filter(Boolean);
```

Pass to `createPiiProxy({ ...other, languages })`.

## 4. Tests

### presidio.test.ts

Update existing tests:
- `PresidioClient` constructor now takes `languages`
- `analyze()` calls mock fetch N times (once per language)
- Assert fetch was called with correct `language` for each request

Add new tests:
- **Multi-language dedup** — mock en returns `{entity_type: 'PERSON', start: 0, end: 5, score: 0.9}`, ru returns `{entity_type: 'PERSON', start: 0, end: 5, score: 0.7}` → result has one entry with score 0.9
- **Non-overlapping entities** — en finds email, ru finds PERSON in different span → both returned
- **Partial failure** — if one language fails, the whole analyze() rejects (we don't want silent data leakage by dropping a language)

### proxy.test.ts

Update `createPiiProxy` call sites in tests to pass `languages: ['en']` to keep existing behavior, and add one test with `languages: ['en', 'ru', 'uk']`.

### integration.test.ts

Add a test that anonymizes mixed text like "Привет Dima, email dima@test.com" and verifies all three (Russian PERSON, English PERSON, EMAIL) are masked.

## 5. Configuration

### .env.example

Add new entry:

```
# Comma-separated list of languages for PII detection (en, ru, uk).
# Each language adds one analyzer HTTP call per anonymization request.
PII_LANGUAGES=en,ru,uk
```

## 6. Documentation

Update `AGENTS.md`:
- Mention custom Presidio Docker image in `presidio/`
- Note that first `docker compose up` takes longer because the image builds locally
- Link to spaCy model versions

## File Changes Summary

### New Files
- `presidio/Dockerfile`
- `presidio/multilang.yaml`

### Modified Files
- `docker-compose.yml` — replace pulled analyzer image with local build
- `packages/server/src/pii/presidio.ts` — accept languages, parallel analyze, dedup
- `packages/server/src/pii/proxy.ts` — add `languages` to config, forward to PresidioClient
- `packages/server/src/index.ts` — read `PII_LANGUAGES` env var
- `packages/server/src/pii/presidio.test.ts` — multi-language tests
- `packages/server/src/pii/proxy.test.ts` — update config sites
- `packages/server/src/pii/integration.test.ts` — mixed language test
- `.env.example` — add PII_LANGUAGES
- `AGENTS.md` — document custom image

## Upgrade Path

When Presidio releases a new version:
1. Update `FROM mcr.microsoft.com/presidio-analyzer:X.Y.Z` in `presidio/Dockerfile`
2. If the new version bumps spaCy major version, update the spaCy model URLs to a matching version
3. Run `docker compose build --no-cache presidio-analyzer`
4. Run existing PII tests to verify no regressions

No code changes needed in the server unless Presidio's API or config format changes (rare for minor versions).

## Edge Cases

- **Presidio unreachable** — existing behavior (PII_MODE=optional → passthrough, required → reject) unchanged
- **One language unavailable** — Presidio logs warning at startup; analyze() throws on requests to that language. Mitigation: PII_LANGUAGES filters out problem languages
- **Mixed-language text** — handled by design; each engine finds what it can, dedup keeps the best match
- **Performance** — 3× analyzer calls. First run of a long message may be slower (~150ms instead of ~50ms). Acceptable tradeoff for correctness
- **Old en-only deployments** — setting `PII_LANGUAGES=en` falls back to single-language behavior (backward compatible)
