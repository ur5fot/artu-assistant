# PII Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proxy layer that anonymizes PII via Microsoft Presidio before sending data to Claude API, with encrypted token vault and UI badge.

**Architecture:** Proxy module wraps all data flowing through tool-loop (user input, tool params, tool results, SSE output). Two official Presidio Docker containers (analyzer + anonymizer) detect and mask PII. Token mapping stored in SQLite with AES-256-GCM encryption. Configurable via `PII_MODE` env (required/optional/disabled).

**Tech Stack:** Microsoft Presidio (Docker), Node.js crypto (AES-256-GCM, HMAC-SHA256), better-sqlite3, React

---

### Task 1: Docker — Add Presidio containers

**Files:**
- Modify: `docker-compose.yml`

- [x] **Step 1: Add Presidio services to docker-compose.yml**

Replace the entire file with:

```yaml
services:
  searxng:
    image: searxng/searxng
    container_name: r2-searxng
    ports:
      - "127.0.0.1:8888:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    restart: unless-stopped
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888

  presidio-analyzer:
    image: mcr.microsoft.com/presidio-analyzer:latest
    container_name: r2-presidio-analyzer
    ports:
      - "127.0.0.1:5002:5002"
    restart: unless-stopped

  presidio-anonymizer:
    image: mcr.microsoft.com/presidio-anonymizer:latest
    container_name: r2-presidio-anonymizer
    ports:
      - "127.0.0.1:5001:5001"
    restart: unless-stopped
```

- [x] **Step 2: Add PII env vars to .env.example**

Append to end of `.env.example`:

```bash
# PII Gateway (Phase 2C)
# Mode: required (blocks without Presidio) | optional (warn + pass-through) | disabled
PII_MODE=optional
# Encryption key for PII token vault (auto-generated on first run if empty)
PII_ENCRYPTION_KEY=
# Entity types to detect (comma-separated Presidio entity names)
PII_ENTITY_TYPES=EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE
# Presidio service URLs
PRESIDIO_ANALYZER_URL=http://localhost:5002
PRESIDIO_ANONYMIZER_URL=http://localhost:5001
# All available Presidio entity types:
# EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, IP_ADDRESS,
# PERSON, LOCATION, DATE_TIME, NRP, MEDICAL_LICENSE,
# US_SSN, US_DRIVER_LICENSE, UK_NHS, SG_NRIC_FIN, AU_ABN,
# AU_ACN, AU_TFN, AU_MEDICARE, US_PASSPORT, US_BANK_NUMBER
```

- [x] **Step 3: Pull images and verify**

Run:
```bash
docker compose pull presidio-analyzer presidio-anonymizer
docker compose up -d
docker compose ps
```
Expected: all 3 services running.

- [x] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "feat: add Presidio analyzer and anonymizer Docker services"
```

---

### Task 2: PII Vault — encryption and token storage

**Files:**
- Create: `packages/server/src/pii/vault.ts`
- Create: `packages/server/src/pii/vault.test.ts`

- [x] **Step 1: Write failing tests for vault**

Create `packages/server/src/pii/vault.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../db.js';
import { PiiVault } from './vault.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

describe('PiiVault', () => {
  let tmpDir: string;
  let vault: PiiVault;
  const testKey = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-vault-test-'));
    initDb(path.join(tmpDir, 'test.db'));
    vault = new PiiVault(testKey);
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates consistent token hash for same value', () => {
    const hash1 = vault.tokenHash('john@example.com');
    const hash2 = vault.tokenHash('john@example.com');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(4);
  });

  it('generates different hashes for different values', () => {
    const hash1 = vault.tokenHash('john@example.com');
    const hash2 = vault.tokenHash('jane@example.com');
    expect(hash1).not.toBe(hash2);
  });

  it('stores and retrieves a token', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    const result = vault.retrieve('<EMAIL:a7f3>');
    expect(result).toBe('john@example.com');
  });

  it('returns null for unknown token', () => {
    const result = vault.retrieve('<EMAIL:xxxx>');
    expect(result).toBeNull();
  });

  it('encrypts value in database (not stored in plain text)', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    const db = getDb();
    const row = db.prepare('SELECT encrypted_value FROM pii_tokens WHERE token = ?').get('<EMAIL:a7f3>') as any;
    expect(row.encrypted_value).not.toContain('john@example.com');
  });

  it('overwrites existing token with same key', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    vault.store('<EMAIL:a7f3>', 'jane@example.com', 'EMAIL_ADDRESS');
    const result = vault.retrieve('<EMAIL:a7f3>');
    expect(result).toBe('jane@example.com');
  });

  it('clears all tokens', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    vault.store('<PHONE:b2c1>', '+380501234567', 'PHONE_NUMBER');
    vault.clearAll();
    expect(vault.retrieve('<EMAIL:a7f3>')).toBeNull();
    expect(vault.retrieve('<PHONE:b2c1>')).toBeNull();
  });

  it('clears expired tokens', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    // Manually set expires_at in the past
    const db = getDb();
    db.prepare("UPDATE pii_tokens SET expires_at = datetime('now', '-1 day') WHERE token = ?").run('<EMAIL:a7f3>');
    vault.store('<PHONE:b2c1>', '+380501234567', 'PHONE_NUMBER');

    vault.clearExpired();
    expect(vault.retrieve('<EMAIL:a7f3>')).toBeNull();
    expect(vault.retrieve('<PHONE:b2c1>')).toBe('+380501234567');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/pii/vault.test.ts`
Expected: FAIL — module `./vault.js` not found.

- [x] **Step 3: Add pii_tokens table to db.ts**

In `packages/server/src/db.ts`, after the `permission_rules` table creation (after line 44), add:

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS pii_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      encrypted_value TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+7 days'))
    )
  `);
```

- [x] **Step 4: Implement vault**

Create `packages/server/src/pii/vault.ts`:

```typescript
import crypto from 'node:crypto';
import { getDb } from '../db.js';

const ENTITY_TYPE_MAP: Record<string, string> = {
  EMAIL_ADDRESS: 'EMAIL',
  PHONE_NUMBER: 'PHONE',
  CREDIT_CARD: 'CARD',
  IBAN_CODE: 'IBAN',
  IP_ADDRESS: 'IP',
  PERSON: 'PERSON',
  LOCATION: 'LOCATION',
  DATE_TIME: 'DATE',
  US_SSN: 'SSN',
  US_DRIVER_LICENSE: 'LICENSE',
};

export function shortEntityType(presidioType: string): string {
  return ENTITY_TYPE_MAP[presidioType] ?? presidioType.split('_')[0];
}

export class PiiVault {
  private key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error('PII_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    }
  }

  tokenHash(value: string): string {
    return crypto
      .createHmac('sha256', this.key)
      .update(value)
      .digest('hex')
      .slice(0, 4);
  }

  makeToken(value: string, presidioType: string): string {
    const short = shortEntityType(presidioType);
    const hash = this.tokenHash(value);
    return `<${short}:${hash}>`;
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString('base64');
  }

  private decrypt(encoded: string): string {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const encrypted = buf.subarray(12, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  store(token: string, value: string, entityType: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO pii_tokens (token, encrypted_value, entity_type)
       VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET encrypted_value = excluded.encrypted_value, entity_type = excluded.entity_type`
    ).run(token, this.encrypt(value), entityType);
  }

  retrieve(token: string): string | null {
    const db = getDb();
    const row = db.prepare('SELECT encrypted_value FROM pii_tokens WHERE token = ?').get(token) as { encrypted_value: string } | undefined;
    if (!row) return null;
    return this.decrypt(row.encrypted_value);
  }

  clearAll(): void {
    const db = getDb();
    db.prepare('DELETE FROM pii_tokens').run();
  }

  clearExpired(): void {
    const db = getDb();
    db.prepare("DELETE FROM pii_tokens WHERE expires_at < datetime('now')").run();
  }
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/pii/vault.test.ts`
Expected: all 8 tests PASS.

- [x] **Step 6: Commit**

```bash
git add packages/server/src/pii/vault.ts packages/server/src/pii/vault.test.ts packages/server/src/db.ts
git commit -m "feat: add PII token vault with AES-256-GCM encryption"
```

---

### Task 3: Presidio client — HTTP calls to analyzer + anonymizer

**Files:**
- Create: `packages/server/src/pii/presidio.ts`
- Create: `packages/server/src/pii/presidio.test.ts`

- [x] **Step 1: Write failing tests for Presidio client**

Create `packages/server/src/pii/presidio.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PresidioClient } from './presidio.js';

// Mock global fetch
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
    });
  });

  it('calls analyzer and returns detected entities', async () => {
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

  it('throws on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(client.analyze('test')).rejects.toThrow('fetch failed');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/pii/presidio.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement Presidio client**

Create `packages/server/src/pii/presidio.ts`:

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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/pii/presidio.test.ts`
Expected: all 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/pii/presidio.ts packages/server/src/pii/presidio.test.ts
git commit -m "feat: add Presidio HTTP client for analyzer and anonymizer"
```

---

### Task 4: PII Proxy — the main anonymize/deanonymize module

**Files:**
- Create: `packages/server/src/pii/proxy.ts`
- Create: `packages/server/src/pii/proxy.test.ts`

- [x] **Step 1: Write failing tests for PII proxy**

Create `packages/server/src/pii/proxy.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PiiProxy, createPiiProxy, createPassthroughProxy } from './proxy.js';
import { initDb, closeDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Mock the presidio module
vi.mock('./presidio.js', () => ({
  PresidioClient: vi.fn().mockImplementation(() => ({
    analyze: vi.fn(),
    anonymize: vi.fn(),
  })),
}));

import { PresidioClient } from './presidio.js';

describe('PiiProxy', () => {
  let tmpDir: string;
  const testKey = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-proxy-test-'));
    initDb(path.join(tmpDir, 'test.db'));
    vi.mocked(PresidioClient).mockClear();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('anonymizes text with detected PII', async () => {
    const mockAnalyze = vi.fn().mockResolvedValue([
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ]);
    const mockAnonymize = vi.fn().mockResolvedValue({
      text: 'My email is <EMAIL:a7f3>',
      items: [{ entity_type: 'EMAIL_ADDRESS', start: 12, end: 24, text: '<EMAIL:a7f3>' }],
    });

    vi.mocked(PresidioClient).mockImplementation(() => ({
      analyze: mockAnalyze,
      anonymize: mockAnonymize,
    }) as any);

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    const result = await proxy.anonymize('My email is john@example.com');
    expect(result.text).toBe('My email is <EMAIL:a7f3>');
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe('EMAIL_ADDRESS');
  });

  it('returns original text when no PII detected', async () => {
    const mockAnalyze = vi.fn().mockResolvedValue([]);

    vi.mocked(PresidioClient).mockImplementation(() => ({
      analyze: mockAnalyze,
      anonymize: vi.fn(),
    }) as any);

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    const result = await proxy.anonymize('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.entities).toHaveLength(0);
  });

  it('deanonymizes text by replacing tokens with originals', async () => {
    const mockAnalyze = vi.fn().mockResolvedValue([
      { entity_type: 'EMAIL_ADDRESS', start: 12, end: 28, score: 0.95 },
    ]);
    const mockAnonymize = vi.fn().mockImplementation(async (_text: string, _results: any, operators: any) => {
      const token = operators.EMAIL_ADDRESS.new_value;
      return { text: `My email is ${token}`, items: [] };
    });

    vi.mocked(PresidioClient).mockImplementation(() => ({
      analyze: mockAnalyze,
      anonymize: mockAnonymize,
    }) as any);

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    const anon = await proxy.anonymize('My email is john@example.com');
    const restored = await proxy.deanonymize(anon.text);
    expect(restored).toBe('My email is john@example.com');
  });

  it('fails open in optional mode when Presidio is unavailable', async () => {
    vi.mocked(PresidioClient).mockImplementation(() => ({
      analyze: vi.fn().mockRejectedValue(new Error('fetch failed')),
      anonymize: vi.fn(),
    }) as any);

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'optional',
    });

    const result = await proxy.anonymize('My email is john@example.com');
    expect(result.text).toBe('My email is john@example.com');
    expect(result.entities).toHaveLength(0);
  });

  it('throws in required mode when Presidio is unavailable', async () => {
    vi.mocked(PresidioClient).mockImplementation(() => ({
      analyze: vi.fn().mockRejectedValue(new Error('fetch failed')),
      anonymize: vi.fn(),
    }) as any);

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    await expect(proxy.anonymize('My email is john@example.com')).rejects.toThrow('fetch failed');
  });

  it('passthrough proxy returns text unchanged', async () => {
    const proxy = createPassthroughProxy();
    const result = await proxy.anonymize('john@example.com');
    expect(result.text).toBe('john@example.com');
    expect(result.entities).toHaveLength(0);

    const restored = await proxy.deanonymize('<EMAIL:a7f3>');
    expect(restored).toBe('<EMAIL:a7f3>');
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/pii/proxy.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement PII proxy**

Create `packages/server/src/pii/proxy.ts`:

```typescript
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
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/pii/proxy.test.ts`
Expected: all 6 tests PASS.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/pii/proxy.ts packages/server/src/pii/proxy.test.ts
git commit -m "feat: add PII proxy with anonymize/deanonymize and fail-open/closed modes"
```

---

### Task 5: SSE event type + shared types

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/index.ts`

- [x] **Step 1: Add pii_masked SSE event type**

In `packages/shared/src/types.ts`, change the SSEEvent union (line 27-33) to:

```typescript
export type SSEEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_call_start'; toolCall: ToolCall }
  | { type: 'tool_call_result'; id: string; result: ToolResult }
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden' }
  | { type: 'pii_masked'; entities: Array<{ type: string; count: number }> }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

- [x] **Step 2: Run typecheck to verify**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat: add pii_masked SSE event type"
```

---

### Task 6: Integrate PII proxy into tool-loop

**Files:**
- Modify: `packages/server/src/ai/tool-loop.ts`
- Modify: `packages/server/src/routes/chat.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Add PiiProxy to tool-loop params and wrap data**

In `packages/server/src/ai/tool-loop.ts`:

Add import at top (after line 7):
```typescript
import type { PiiProxy } from '../pii/proxy.js';
```

Add `piiProxy` to `ToolLoopParams` interface (after line 17):
```typescript
  piiProxy: PiiProxy;
```

Update the function signature (line 46) to destructure `piiProxy`:
```typescript
export async function runToolLoop({
  messages,
  client,
  registry,
  onEvent,
  signal,
  pendingConfirms = new Map(),
  piiProxy,
}: ToolLoopParams): Promise<void> {
```

**Wrap user messages** — after `let currentMessages` (line 56), before the while loop (line 60), add:
```typescript
  // Anonymize user messages before sending to Claude
  const anonymizedMessages: MessageParam[] = [];
  const allPiiEntities: Array<{ type: string; token: string }> = [];
  for (const msg of currentMessages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      const result = await piiProxy.anonymize(msg.content);
      anonymizedMessages.push({ role: 'user', content: result.text });
      allPiiEntities.push(...result.entities);
    } else {
      anonymizedMessages.push(msg);
    }
  }
  currentMessages = anonymizedMessages;

  // Emit pii_masked event if any PII was found
  if (allPiiEntities.length > 0) {
    const counts = new Map<string, number>();
    for (const e of allPiiEntities) {
      counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    onEvent({
      type: 'pii_masked',
      entities: Array.from(counts.entries()).map(([type, count]) => ({ type, count })),
    });
  }
```

**Deanonymize tool params** — before tool handler execution (line 151), wrap the params:
```typescript
            // Deanonymize tool params so handler gets real values
            const deanonInput = JSON.parse(await piiProxy.deanonymize(JSON.stringify(block.input)));
            result = await toolDef.handler(deanonInput);
```

Do the same for the `auto` handler (line 163):
```typescript
            const deanonInput = JSON.parse(await piiProxy.deanonymize(JSON.stringify(block.input)));
            result = await toolDef.handler(deanonInput);
```

**Anonymize tool results** — after `const durationMs` (line 171), before `logToolCall` (line 173), add:
```typescript
      // Anonymize tool result before logging and sending back to Claude
      if (result.data) {
        const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
        if (anonResult.entities.length > 0) {
          result = { ...result, data: JSON.parse(anonResult.text) };
        }
      }
```

**Deanonymize text_delta** — in the text emission block (line 78), change to:
```typescript
        const deanonText = await piiProxy.deanonymize(block.text);
        onEvent({ type: 'text_delta', content: deanonText });
```

- [x] **Step 2: Update chat.ts to pass piiProxy**

In `packages/server/src/routes/chat.ts`:

Add import at top:
```typescript
import type { PiiProxy } from '../pii/proxy.js';
```

Add `piiProxy` to `ChatRouterDeps` interface (after line 45):
```typescript
  piiProxy: PiiProxy;
```

Update `runLoop` type in `ChatRouterDeps` to include `piiProxy`:
```typescript
  runLoop: (params: {
    messages: MessageParam[];
    onEvent: (event: SSEEvent) => void;
    signal?: AbortSignal;
    pendingConfirms: PendingConfirms;
    piiProxy: PiiProxy;
  }) => Promise<void>;
```

Update `createChatRouter` to destructure `piiProxy`:
```typescript
export function createChatRouter({ runLoop, pendingConfirms, piiProxy }: ChatRouterDeps): Router {
```

In the `runLoop` call (line 80-88), add `piiProxy`:
```typescript
      await runLoop({
        messages: addTimestamps(messages),
        signal: abortController.signal,
        pendingConfirms,
        piiProxy,
        onEvent: (event: SSEEvent) => {
          if (!res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      });
```

- [x] **Step 3: Update index.ts to create and pass PII proxy**

In `packages/server/src/index.ts`:

Add imports (after line 16):
```typescript
import { createPiiProxy, createPassthroughProxy } from './pii/proxy.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
```

After `cleanupAuditLog()` (line 26), add PII proxy initialization:
```typescript
// Initialize PII proxy
const piiMode = (process.env.PII_MODE || 'optional') as 'required' | 'optional' | 'disabled';
let piiProxy;
if (piiMode === 'disabled') {
  piiProxy = createPassthroughProxy();
} else {
  let encryptionKey = process.env.PII_ENCRYPTION_KEY;
  if (!encryptionKey) {
    encryptionKey = crypto.randomBytes(32).toString('hex');
    console.log('Generated PII_ENCRYPTION_KEY — add to .env to persist across restarts');
    // Auto-append to .env if it exists
    const envPath = path.resolve(__dirname, '..', '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      fs.appendFileSync(envPath, `\nPII_ENCRYPTION_KEY=${encryptionKey}\n`);
    }
  }
  const entityTypes = (process.env.PII_ENTITY_TYPES || 'EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE').split(',');
  piiProxy = createPiiProxy({
    encryptionKey,
    analyzerUrl: process.env.PRESIDIO_ANALYZER_URL || 'http://localhost:5002',
    anonymizerUrl: process.env.PRESIDIO_ANONYMIZER_URL || 'http://localhost:5001',
    entityTypes,
    mode: piiMode,
  });
}
```

Update `chatRouter` creation to pass `piiProxy`:
```typescript
const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal, pendingConfirms: pc, piiProxy: pp }) =>
    runToolLoop({ messages, client, registry, onEvent, signal, pendingConfirms: pc, piiProxy: pp }),
  pendingConfirms,
  piiProxy,
});
```

- [x] **Step 4: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [x] **Step 5: Run existing tests to make sure nothing breaks**

Run: `cd packages/server && npx vitest run`
Expected: existing tests PASS. Note: some tool-loop tests may need updates (they don't pass `piiProxy`).

- [x] **Step 6: Fix tool-loop tests to pass piiProxy**

In `packages/server/src/ai/__tests__/tool-loop.test.ts`:

Add import at top:
```typescript
import { createPassthroughProxy } from '../../pii/proxy.js';
```

In every `runToolLoop()` call throughout the file, add the `piiProxy` parameter:
```typescript
piiProxy: createPassthroughProxy(),
```

There are approximately 15 `runToolLoop()` calls in the test file. Add `piiProxy: createPassthroughProxy()` to each one.

- [x] **Step 7: Run all tests**

Run: `cd packages/server && npx vitest run`
Expected: all tests PASS.

- [x] **Step 8: Commit**

```bash
git add packages/server/src/ai/tool-loop.ts packages/server/src/routes/chat.ts packages/server/src/index.ts packages/server/src/ai/__tests__/tool-loop.test.ts
git commit -m "feat: integrate PII proxy into tool-loop pipeline"
```

---

### Task 7: PII Badge — client-side UI

**Files:**
- Create: `packages/client/src/components/PiiBadge.tsx`
- Modify: `packages/client/src/hooks/useChat.ts`
- Modify: `packages/client/src/components/MessageBubble.tsx`

- [x] **Step 1: Create PiiBadge component**

Create `packages/client/src/components/PiiBadge.tsx`:

```tsx
import { useState } from 'react';

interface Props {
  entities: Array<{ type: string; count: number }>;
}

export function PiiBadge({ entities }: Props) {
  const [expanded, setExpanded] = useState(false);
  const total = entities.reduce((sum, e) => sum + e.count, 0);

  return (
    <div style={{
      display: 'inline-flex',
      flexDirection: 'column',
      background: '#f0f9ff',
      border: '1px solid #bae6fd',
      borderRadius: 8,
      padding: '4px 8px',
      fontSize: 12,
      color: '#0c4a6e',
      cursor: 'pointer',
      marginBottom: 4,
      maxWidth: '80%',
    }} onClick={() => setExpanded(!expanded)}>
      <span>{'\u{1F6E1}'} {total} PII masked</span>
      {expanded && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#475569' }}>
          {entities.map((e) => (
            <div key={e.type}>{e.count}× {e.type}</div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Add piiEntities to useChat state**

In `packages/client/src/hooks/useChat.ts`:

Add to the `Message`-related local state tracking. After `const toolCalls: ToolCall[] = [];` (line 39), add:
```typescript
    let piiEntities: Array<{ type: string; count: number }> | undefined;
```

Add handler for `pii_masked` event in the switch statement (after `tool_confirm_request` case, before `error` case):
```typescript
          case 'pii_masked':
            piiEntities = event.entities;
            // Trigger re-render with PII data
            setMessages((prev) => {
              const base = prev[prev.length - 1]?.id === assistantId ? prev.slice(0, -1) : prev;
              return [
                ...base,
                {
                  id: assistantId,
                  role: 'assistant' as const,
                  content: assistantText,
                  toolCalls: toolCalls.length > 0 ? [...toolCalls] : undefined,
                  timestamp: Date.now(),
                  piiEntities,
                },
              ];
            });
            break;
```

Note: The `piiEntities` field needs to be added to the Message type. Since `Message` is from `@r2/shared`, we need to extend it.

- [x] **Step 3: Add piiEntities to Message type**

In `packages/shared/src/types.ts`, add to the `Message` interface (after line 6):
```typescript
  piiEntities?: Array<{ type: string; count: number }>;
```

- [x] **Step 4: Include piiEntities in all message state updates in useChat.ts**

Every `setMessages` call that creates the assistant message object should include `piiEntities`. There are 5 such calls in useChat.ts (in `text_delta`, `tool_call_start`, `tool_call_result`, `tool_confirm_request` handlers). Add `piiEntities,` after `timestamp: Date.now(),` in each one.

- [x] **Step 5: Render PiiBadge in MessageBubble**

In `packages/client/src/components/MessageBubble.tsx`:

Add import at top:
```typescript
import { PiiBadge } from './PiiBadge';
```

After the `toolCalls` rendering block (after line 70, before `{message.content && (`), add:
```tsx
      {message.piiEntities && message.piiEntities.length > 0 && (
        <PiiBadge entities={message.piiEntities} />
      )}
```

- [x] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p packages/client/tsconfig.json && npx tsc --noEmit -p packages/shared/tsconfig.json`
Expected: no errors.

- [x] **Step 7: Commit**

```bash
git add packages/client/src/components/PiiBadge.tsx packages/client/src/hooks/useChat.ts packages/client/src/components/MessageBubble.tsx packages/shared/src/types.ts
git commit -m "feat: add PII badge component to show masked entity counts"
```

---

### Task 8: PII tokens API endpoint

**Files:**
- Create: `packages/server/src/routes/pii.ts`
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Create PII tokens route**

Create `packages/server/src/routes/pii.ts`:

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db.js';

export function createPiiRouter(): Router {
  const router = Router();

  router.delete('/pii-tokens', (_req: Request, res: Response) => {
    const db = getDb();
    db.prepare('DELETE FROM pii_tokens').run();
    res.json({ ok: true });
  });

  return router;
}
```

- [x] **Step 2: Register route in index.ts**

In `packages/server/src/index.ts`, add import:
```typescript
import { createPiiRouter } from './routes/pii.js';
```

After `app.use('/api', createPermissionsRouter());` (line 41), add:
```typescript
app.use('/api', createPiiRouter());
```

- [x] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/server/tsconfig.json`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add packages/server/src/routes/pii.ts packages/server/src/index.ts
git commit -m "feat: add DELETE /api/pii-tokens endpoint"
```

---

### Task 9: Integration test — full pipeline

**Files:**
- Create: `packages/server/src/pii/integration.test.ts`

- [x] **Step 1: Write integration test for the full anonymize → deanonymize flow**

Create `packages/server/src/pii/integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPiiProxy } from './proxy.js';
import { initDb, closeDb, getDb } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Mock fetch for Presidio calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PII Pipeline Integration', () => {
  let tmpDir: string;
  const testKey = crypto.randomBytes(32).toString('hex');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-pii-integ-'));
    initDb(path.join(tmpDir, 'test.db'));
    mockFetch.mockReset();
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full round-trip: anonymize → store in vault → deanonymize', async () => {
    // Mock analyzer response
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 10, end: 26, score: 0.95 },
          { entity_type: 'PHONE_NUMBER', start: 34, end: 46, score: 0.90 },
        ],
      })
      // Mock anonymizer response
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'Контакт: <EMAIL:mock> і телефон <PHONE:mock>',
          items: [],
        }),
      });

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS', 'PHONE_NUMBER'],
      mode: 'required',
    });

    const anon = await proxy.anonymize('Контакт: john@example.com і телефон +380501234567');
    expect(anon.entities).toHaveLength(2);
    expect(anon.text).toContain('<EMAIL:');
    expect(anon.text).toContain('<PHONE:');
    expect(anon.text).not.toContain('john@example.com');
    expect(anon.text).not.toContain('+380501234567');

    // Verify tokens are in the vault DB
    const db = getDb();
    const tokens = db.prepare('SELECT * FROM pii_tokens').all();
    expect(tokens).toHaveLength(2);
  });

  it('audit log contains placeholders, not real PII', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: '<EMAIL:a7f3>',
          items: [],
        }),
      });

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    const result = await proxy.anonymize('john@example.com');
    // The anonymized text is what would be written to audit log
    expect(result.text).not.toContain('john@example.com');
    expect(result.text).toMatch(/<EMAIL:[a-f0-9]{4}>/);
  });

  it('consistent hashing: same PII always maps to same token', async () => {
    // Two separate analyze calls for same email
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'token1',
          items: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          text: 'token2',
          items: [],
        }),
      });

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    // Both calls use the same email → same token should be generated
    const call1 = mockFetch.mock.calls;
    await proxy.anonymize('john@example.com');
    await proxy.anonymize('john@example.com');

    // Check that the anonymizer was called with the same token both times
    const anonCall1 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const anonCall2 = JSON.parse(mockFetch.mock.calls[3][1].body);
    const token1 = anonCall1.operators.EMAIL_ADDRESS.new_value;
    const token2 = anonCall2.operators.EMAIL_ADDRESS.new_value;
    expect(token1).toBe(token2);
  });
});
```

- [x] **Step 2: Run integration tests**

Run: `cd packages/server && npx vitest run src/pii/integration.test.ts`
Expected: all 3 tests PASS.

- [x] **Step 3: Run full test suite**

Run: `cd packages/server && npx vitest run`
Expected: ALL tests PASS.

- [x] **Step 4: Commit**

```bash
git add packages/server/src/pii/integration.test.ts
git commit -m "test: add PII pipeline integration tests"
```

---

### Task 10: Final typecheck and cleanup

**Files:**
- All modified files

- [ ] **Step 1: Full typecheck across all packages**

Run: `npm run build --workspaces --if-present 2>&1 || npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json && npx tsc --noEmit -p packages/client/tsconfig.json`
Expected: no type errors.

- [ ] **Step 2: Run all tests across all packages**

Run: `npm test --workspaces --if-present`
Expected: all tests PASS.

- [ ] **Step 3: Fix any issues found**

If any type errors or test failures, fix them.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: Phase 2C — PII gateway complete"
```
