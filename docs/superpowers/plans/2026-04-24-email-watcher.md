# Email Watcher + tool-emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить multi-account IMAP poller с LLM-scoring, `emailDigest` cognition handler (проактивный push в Discord с quiet hours и cooldown) и новый `@r2/tool-emails` (операции `emails_list` и `emails_get`) для on-demand чтения почты из чата.

**Architecture:** Новый модуль `packages/server/src/emails/` (imap-client, scorer, store, poller) изолирован от cognition. Хендлер `emailDigest` потребляет store. `packages/tool-emails/` — отдельный пакет, экспортирует `createTool({ emailStore, imapClient })` → массив `ToolDefinition`. Конфиг через env JSON (`IMAP_ACCOUNTS`), секреты в `.env`, не в БД.

**Tech Stack:** TypeScript, vitest, better-sqlite3, `imapflow` (новая dep), existing Ollama→Claude router, existing PII proxy, Anthropic SDK.

**Spec:** `docs/superpowers/specs/2026-04-24-email-watcher-design.md`

---

## File Structure

**Create (server-side):**
- `packages/server/src/emails/types.ts` — `ImapAccount`, `NewMessage`, `FullMessage`, `EmailPendingRow`
- `packages/server/src/emails/config.ts` — `parseImapAccounts(envJson)`
- `packages/server/src/emails/imap-client.ts` — `fetchNewMessages`, `fetchFullBody` via `imapflow`
- `packages/server/src/emails/scorer.ts` — `scoreBatch` (batched LLM, Ollama→Claude fallback, PII)
- `packages/server/src/emails/store.ts` — CRUD on `email_account_state` + `email_pending`
- `packages/server/src/emails/multi-account-poller.ts` — `startEmailPoller({...}) → stop()`
- `packages/server/src/cognition/handlers/emailDigest.ts` — trigger + run
- `packages/server/src/cognition/handlers/emailDigest.helpers.ts` — `inQuietHours`, `morningBriefPublishedToday`, `formatDigest`
- Tests: one `*.test.ts` per module above under `__tests__` mirror

**Create (tool package):**
- `packages/tool-emails/package.json`
- `packages/tool-emails/tsconfig.json`
- `packages/tool-emails/src/index.ts` — `createTool({ emailStore, imapClient })` → `ToolDefinition[]`
- `packages/tool-emails/src/types.ts` — public interfaces for deps
- `packages/tool-emails/src/__tests__/index.test.ts`

**Modify:**
- `packages/server/src/db.ts` — add two `CREATE TABLE IF NOT EXISTS` + index
- `packages/server/src/tools/base.ts` — extend `ToolDeps` with `emailStore?`, `imapClient?`
- `packages/server/src/index.ts` — parse accounts, start poller, register handler, pass deps to `discoverTools`
- `packages/server/package.json` — add `imapflow` dependency
- `packages/shared/src/types.ts` — **no changes** (ToolDefinition already covers us)

---

## Testing Strategy

- vitest (project convention). Run scoped: `npm -w @r2/server test -- <pattern>`.
- `initDb(':memory:')` per test for anything touching DB.
- `imapflow` mocked via object stub (class has clean method surface: `connect`, `mailboxOpen`, `search`, `fetchAll`, `logout`). Do NOT spin up real IMAP.
- LLM mocked via `vi.fn()` on ollama/anthropic clients (pattern from `morningBrief.ai.test.ts`).
- PII proxy → `fakeProxy()` pass-through (same pattern as morning-brief tests).
- No integration tests against real providers.

---

## Progress Tracking

- `[x]` as soon as a step is done.
- ➕ for newly found sub-tasks.
- ⚠️ for blockers.

---

## Task 1: DB migrations — new tables

**Files:**
- Modify: `packages/server/src/db.ts`
- Test: `packages/server/src/__tests__/db.test.ts` (create if absent; else append)

- [x] **Step 1: Write failing test**

Append or create `packages/server/src/__tests__/db.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../db.js';

beforeEach(() => initDb(':memory:'));

describe('email tables', () => {
  it('creates email_account_state with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_account_state')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['account_id', 'last_error', 'last_poll_at', 'last_seen_uid'].sort());
  });

  it('creates email_pending with expected columns', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info('email_pending')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'account_id', 'added_at', 'delivered_at', 'from_addr',
      'id', 'importance', 'message_uid', 'received_at', 'snippet', 'subject',
    ].sort());
  });

  it('enforces UNIQUE(account_id, message_uid) on email_pending', () => {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO email_pending
      (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000);
    expect(() => stmt.run('acc1', 123, 'a@b.com', 's', 'snip', 4, 1000, 1000)).toThrow();
  });
});
```

- [x] **Step 2: Run test — expect FAIL**

Run: `npm -w @r2/server test -- db.test`
Expected: "no such table" or table missing.

- [x] **Step 3: Implement — append tables to `db.ts` `initDb`**

Insert after the last existing `CREATE TABLE` block (after `cognition_handler_runs`):

```typescript
db.exec(`
  CREATE TABLE IF NOT EXISTS email_account_state (
    account_id TEXT PRIMARY KEY,
    last_seen_uid INTEGER NOT NULL DEFAULT 0,
    last_poll_at INTEGER,
    last_error TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS email_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    message_uid INTEGER NOT NULL,
    from_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    snippet TEXT NOT NULL,
    importance INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(account_id, message_uid)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_email_pending_undelivered
    ON email_pending(delivered_at, importance DESC, received_at DESC)
`);
```

- [x] **Step 4: Run test — expect PASS**

Run: `npm -w @r2/server test -- db.test`
Expected: 3 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/__tests__/db.test.ts
git commit -m "feat(emails): add email_account_state and email_pending tables"
```

---

## Task 2: Account config parser

**Files:**
- Create: `packages/server/src/emails/types.ts`
- Create: `packages/server/src/emails/config.ts`
- Create: `packages/server/src/emails/__tests__/config.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/emails/__tests__/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseImapAccounts } from '../config.js';

describe('parseImapAccounts', () => {
  it('returns empty array for empty/missing env', () => {
    expect(parseImapAccounts(undefined)).toEqual([]);
    expect(parseImapAccounts('')).toEqual([]);
    expect(parseImapAccounts('[]')).toEqual([]);
  });

  it('parses valid JSON array into typed accounts', () => {
    const raw = JSON.stringify([
      { id: 'gmail-main', host: 'imap.gmail.com', port: 993, user: 'a@gmail.com', password: 'p1', tls: true },
      { id: 'icloud', host: 'imap.mail.me.com', port: 993, user: 'a@icloud.com', password: 'p2', tls: true },
    ]);
    const accounts = parseImapAccounts(raw);
    expect(accounts).toHaveLength(2);
    expect(accounts[0].id).toBe('gmail-main');
    expect(accounts[1].host).toBe('imap.mail.me.com');
  });

  it('throws on duplicate id', () => {
    const raw = JSON.stringify([
      { id: 'x', host: 'h', port: 993, user: 'u', password: 'p', tls: true },
      { id: 'x', host: 'h2', port: 993, user: 'u2', password: 'p2', tls: true },
    ]);
    expect(() => parseImapAccounts(raw)).toThrow(/duplicate/);
  });

  it('throws on missing required field', () => {
    const raw = JSON.stringify([{ id: 'x', host: 'h', port: 993, user: 'u', tls: true }]);
    expect(() => parseImapAccounts(raw)).toThrow(/password/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseImapAccounts('{bad json')).toThrow();
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- config.test`
Expected: import failure, config.ts not yet created.

- [x] **Step 3: Implement types and parser**

Create `packages/server/src/emails/types.ts`:

```typescript
export interface ImapAccount {
  id: string;
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface NewMessage {
  uid: number;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: number;
}

export interface FullMessage {
  uid: number;
  from: string;
  subject: string;
  bodyText: string;
  receivedAt: number;
}

export interface EmailPendingRow {
  id: number;
  account_id: string;
  message_uid: number;
  from_addr: string;
  subject: string;
  snippet: string;
  importance: number;
  received_at: number;
  added_at: number;
  delivered_at: number | null;
}
```

Create `packages/server/src/emails/config.ts`:

```typescript
import type { ImapAccount } from './types.js';

const REQUIRED: Array<keyof ImapAccount> = ['id', 'host', 'port', 'user', 'password', 'tls'];

export function parseImapAccounts(raw: string | undefined): ImapAccount[] {
  if (!raw || raw.trim() === '' || raw.trim() === '[]') return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('IMAP_ACCOUNTS must be a JSON array');
  }
  const seen = new Set<string>();
  const out: ImapAccount[] = [];
  for (const item of parsed) {
    for (const key of REQUIRED) {
      if (item[key] === undefined || item[key] === null) {
        throw new Error(`IMAP account missing required field "${key}"`);
      }
    }
    if (seen.has(item.id)) {
      throw new Error(`IMAP accounts contain duplicate id "${item.id}"`);
    }
    seen.add(item.id);
    out.push({
      id: String(item.id),
      host: String(item.host),
      port: Number(item.port),
      user: String(item.user),
      password: String(item.password),
      tls: Boolean(item.tls),
    });
  }
  return out;
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- config.test`
Expected: 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/emails/types.ts packages/server/src/emails/config.ts packages/server/src/emails/__tests__/config.test.ts
git commit -m "feat(emails): add IMAP_ACCOUNTS config parser and shared types"
```

---

## Task 3: Email store (CRUD)

**Files:**
- Create: `packages/server/src/emails/store.ts`
- Create: `packages/server/src/emails/__tests__/store.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/emails/__tests__/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';

beforeEach(() => initDb(':memory:'));

describe('createEmailStore', () => {
  it('getLastSeenUid returns 0 for unknown account', () => {
    const store = createEmailStore({ db: getDb() });
    expect(store.getLastSeenUid('missing')).toBe(0);
  });

  it('updateLastSeenUid upserts row', () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('acc1', 42, 1000);
    expect(store.getLastSeenUid('acc1')).toBe(42);
    store.updateLastSeenUid('acc1', 99, 2000);
    expect(store.getLastSeenUid('acc1')).toBe(99);
  });

  it('insertPending + countPendingUndelivered respects delivered_at', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'acc1', message_uid: 1, from_addr: 'a@b', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    store.insertPending({
      account_id: 'acc1', message_uid: 2, from_addr: 'a@b', subject: 's2',
      snippet: 'y', importance: 5, received_at: 2000, added_at: 2000,
    });
    expect(store.countPendingUndelivered()).toBe(2);
    const rows = store.fetchPendingUndelivered(50);
    store.markDelivered(rows.map((r) => r.id), 3000);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('insertPending is idempotent on duplicate (account_id, message_uid)', () => {
    const store = createEmailStore({ db: getDb() });
    const payload = {
      account_id: 'acc1', message_uid: 7, from_addr: 'a@b', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    };
    store.insertPending(payload);
    store.insertPending(payload); // should not throw, should not duplicate
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('fetchPendingUndelivered sorts by importance desc, received_at desc', () => {
    const store = createEmailStore({ db: getDb() });
    const mk = (uid: number, importance: number, received_at: number) => ({
      account_id: 'a', message_uid: uid, from_addr: 'x', subject: 's',
      snippet: 'x', importance, received_at, added_at: received_at,
    });
    store.insertPending(mk(1, 4, 1000));
    store.insertPending(mk(2, 5, 500));
    store.insertPending(mk(3, 5, 1500));
    const rows = store.fetchPendingUndelivered(50);
    expect(rows.map((r) => r.message_uid)).toEqual([3, 2, 1]);
  });

  it('fetchInWindow returns rows within since_hours', () => {
    const store = createEmailStore({ db: getDb() });
    const now = Date.now();
    store.insertPending({
      account_id: 'a', message_uid: 1, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: now - 10 * 3600_000, added_at: now,
    });
    store.insertPending({
      account_id: 'a', message_uid: 2, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: now - 100 * 3600_000, added_at: now,
    });
    const rows = store.fetchInWindow(72, 10, now);
    expect(rows.map((r) => r.message_uid)).toEqual([1]);
  });

  it('setAccountError writes last_error without clobbering last_seen_uid', () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 42, 1000);
    store.setAccountError('a', 'auth failed', 2000);
    expect(store.getLastSeenUid('a')).toBe(42);
    const err = store.getAccountError('a');
    expect(err).toEqual({ message: 'auth failed', at: 2000 });
  });

  it('findByPendingId returns the row or null', () => {
    const store = createEmailStore({ db: getDb() });
    store.insertPending({
      account_id: 'a', message_uid: 5, from_addr: 'x', subject: 's',
      snippet: 'x', importance: 4, received_at: 1000, added_at: 1000,
    });
    const rows = store.fetchPendingUndelivered(50);
    const id = rows[0].id;
    expect(store.findByPendingId(id)?.message_uid).toBe(5);
    expect(store.findByPendingId(9999)).toBeNull();
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- store.test`
Expected: module not found.

- [x] **Step 3: Implement `emails/store.ts`**

```typescript
import type Database from 'better-sqlite3';
import type { EmailPendingRow } from './types.js';

export interface EmailStore {
  getLastSeenUid(accountId: string): number;
  updateLastSeenUid(accountId: string, uid: number, now: number): void;
  setAccountError(accountId: string, message: string, now: number): void;
  getAccountError(accountId: string): { message: string; at: number } | null;

  insertPending(row: Omit<EmailPendingRow, 'id' | 'delivered_at'>): void;
  countPendingUndelivered(): number;
  fetchPendingUndelivered(limit: number): EmailPendingRow[];
  fetchInWindow(sinceHours: number, limit: number, now: number): EmailPendingRow[];
  markDelivered(ids: number[], now: number): void;
  findByPendingId(id: number): EmailPendingRow | null;
}

export function createEmailStore(deps: { db: Database.Database }): EmailStore {
  const { db } = deps;
  return {
    getLastSeenUid(accountId) {
      const row = db
        .prepare('SELECT last_seen_uid FROM email_account_state WHERE account_id = ?')
        .get(accountId) as { last_seen_uid: number } | undefined;
      return row?.last_seen_uid ?? 0;
    },
    updateLastSeenUid(accountId, uid, now) {
      db.prepare(`
        INSERT INTO email_account_state (account_id, last_seen_uid, last_poll_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          last_seen_uid = excluded.last_seen_uid,
          last_poll_at = excluded.last_poll_at,
          last_error = NULL
      `).run(accountId, uid, now);
    },
    setAccountError(accountId, message, now) {
      db.prepare(`
        INSERT INTO email_account_state (account_id, last_seen_uid, last_poll_at, last_error)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          last_poll_at = excluded.last_poll_at,
          last_error = excluded.last_error
      `).run(accountId, now, message);
    },
    getAccountError(accountId) {
      const row = db
        .prepare('SELECT last_error, last_poll_at FROM email_account_state WHERE account_id = ?')
        .get(accountId) as { last_error: string | null; last_poll_at: number | null } | undefined;
      if (!row || !row.last_error) return null;
      return { message: row.last_error, at: row.last_poll_at ?? 0 };
    },
    insertPending(row) {
      db.prepare(`
        INSERT OR IGNORE INTO email_pending
        (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.account_id, row.message_uid, row.from_addr, row.subject,
        row.snippet, row.importance, row.received_at, row.added_at,
      );
    },
    countPendingUndelivered() {
      const row = db
        .prepare('SELECT COUNT(*) AS c FROM email_pending WHERE delivered_at IS NULL')
        .get() as { c: number };
      return row.c;
    },
    fetchPendingUndelivered(limit) {
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE delivered_at IS NULL
        ORDER BY importance DESC, received_at DESC
        LIMIT ?
      `).all(limit) as EmailPendingRow[];
    },
    fetchInWindow(sinceHours, limit, now) {
      const cutoff = now - sinceHours * 3600_000;
      return db.prepare(`
        SELECT * FROM email_pending
        WHERE received_at >= ?
        ORDER BY importance DESC, received_at DESC
        LIMIT ?
      `).all(cutoff, limit) as EmailPendingRow[];
    },
    markDelivered(ids, now) {
      if (ids.length === 0) return;
      const stmt = db.prepare('UPDATE email_pending SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL');
      const txn = db.transaction((all: number[]) => {
        for (const id of all) stmt.run(now, id);
      });
      txn(ids);
    },
    findByPendingId(id) {
      const row = db.prepare('SELECT * FROM email_pending WHERE id = ?').get(id) as EmailPendingRow | undefined;
      return row ?? null;
    },
  };
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- store.test`
Expected: 8 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/emails/store.ts packages/server/src/emails/__tests__/store.test.ts
git commit -m "feat(emails): add SQLite store for accounts and pending messages"
```

---

## Task 4: Add imapflow dependency + IMAP client wrapper

**Files:**
- Modify: `packages/server/package.json` (+ lockfile)
- Create: `packages/server/src/emails/imap-client.ts`
- Create: `packages/server/src/emails/__tests__/imap-client.test.ts`

- [x] **Step 1: Add dependency**

Run:
```bash
npm -w @r2/server install imapflow@^1.0.160
```

Verify `package.json` now has `"imapflow": "^1.0.160"`.

- [x] **Step 2: Write failing test (mocked imapflow)**

Create `packages/server/src/emails/__tests__/imap-client.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { ImapAccount } from '../types.js';
import { fetchNewMessages, fetchFullBody, __setImapFlowCtor } from '../imap-client.js';

const account: ImapAccount = {
  id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true,
};

function makeClientStub(options: {
  searchReturns?: number[];
  fetchRows?: Array<{ uid: number; envelope: any; bodyParts: Record<string, Buffer>; internalDate: Date }>;
  throwOn?: 'connect' | 'search' | 'fetch';
}) {
  const { searchReturns = [], fetchRows = [], throwOn } = options;
  return class {
    async connect() { if (throwOn === 'connect') throw new Error('connect fail'); }
    async logout() {}
    mailboxOpen = vi.fn(async () => {});
    search = vi.fn(async () => {
      if (throwOn === 'search') throw new Error('search fail');
      return searchReturns;
    });
    fetchAll = vi.fn(async () => {
      if (throwOn === 'fetch') throw new Error('fetch fail');
      return fetchRows;
    });
    fetchOne = vi.fn(async (_uid: number, _opts: any) => {
      return fetchRows[0] ?? null;
    });
  };
}

describe('fetchNewMessages', () => {
  it('returns empty when nothing above sinceUid', async () => {
    __setImapFlowCtor(makeClientStub({ searchReturns: [] }));
    const msgs = await fetchNewMessages(account, 100, 50);
    expect(msgs).toEqual([]);
  });

  it('maps imapflow rows to NewMessage[]', async () => {
    const body = Buffer.from('First 500 chars of the body...');
    __setImapFlowCtor(
      makeClientStub({
        searchReturns: [101, 102],
        fetchRows: [
          {
            uid: 101,
            envelope: {
              from: [{ name: 'Alice', address: 'a@b.com' }],
              subject: 'hi',
            },
            bodyParts: new Map([['1', body]]) as any,
            internalDate: new Date('2026-04-24T10:00:00Z'),
          },
        ],
      }),
    );
    const msgs = await fetchNewMessages(account, 100, 50);
    expect(msgs[0]).toMatchObject({
      uid: 101, from: expect.stringContaining('Alice'), subject: 'hi',
    });
    expect(msgs[0].snippet.length).toBeLessThanOrEqual(500);
    expect(msgs[0].receivedAt).toBe(new Date('2026-04-24T10:00:00Z').getTime());
  });

  it('propagates connection errors', async () => {
    __setImapFlowCtor(makeClientStub({ throwOn: 'connect' }));
    await expect(fetchNewMessages(account, 0, 10)).rejects.toThrow(/connect/);
  });
});

describe('fetchFullBody', () => {
  it('returns body text for a uid', async () => {
    const body = Buffer.from('Full body text here');
    __setImapFlowCtor(
      makeClientStub({
        fetchRows: [
          {
            uid: 5,
            envelope: { from: [{ address: 'x@y' }], subject: 's' },
            bodyParts: new Map([['1', body]]) as any,
            internalDate: new Date(0),
          },
        ],
      }),
    );
    const full = await fetchFullBody(account, 5);
    expect(full.bodyText).toContain('Full body text here');
  });

  it('throws when uid not found', async () => {
    __setImapFlowCtor(makeClientStub({ fetchRows: [] }));
    await expect(fetchFullBody(account, 999)).rejects.toThrow(/not found/i);
  });
});
```

- [x] **Step 3: Run — expect FAIL**

Run: `npm -w @r2/server test -- imap-client.test`
Expected: module not found.

- [x] **Step 4: Implement `emails/imap-client.ts`**

```typescript
import { ImapFlow } from 'imapflow';
import type { ImapAccount, NewMessage, FullMessage } from './types.js';

type ImapFlowCtor = new (opts: any) => any;
let Ctor: ImapFlowCtor = ImapFlow as unknown as ImapFlowCtor;

// Test seam — swap ImapFlow with a stub in tests.
export function __setImapFlowCtor(c: ImapFlowCtor): void {
  Ctor = c;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SNIPPET_LEN = 500;

function formatFrom(envelope: any): string {
  const from = envelope?.from?.[0];
  if (!from) return 'unknown';
  if (from.name && from.address) return `${from.name} <${from.address}>`;
  return from.address || from.name || 'unknown';
}

function extractSnippet(bodyParts: any, limit: number): string {
  if (!bodyParts) return '';
  // imapflow returns bodyParts as a Map<partId, Buffer>
  for (const value of bodyParts.values?.() ?? Object.values(bodyParts)) {
    const text = Buffer.isBuffer(value) ? value.toString('utf-8') : String(value);
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.slice(0, limit);
  }
  return '';
}

async function withClient<T>(account: ImapAccount, fn: (client: any) => Promise<T>): Promise<T> {
  const client = new Ctor({
    host: account.host,
    port: account.port,
    secure: account.tls,
    auth: { user: account.user, pass: account.password },
    logger: false,
    socketTimeout: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    return await fn(client);
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
}

export async function fetchNewMessages(
  account: ImapAccount,
  sinceUid: number,
  limit: number,
): Promise<NewMessage[]> {
  return withClient(account, async (client) => {
    const uids: number[] = (await client.search({ uid: `${sinceUid + 1}:*` })) || [];
    if (!uids || uids.length === 0) return [];
    const cap = uids.slice(-limit);
    const rows = await client.fetchAll(cap, {
      envelope: true,
      internalDate: true,
      bodyParts: ['1'],
    });
    const out: NewMessage[] = [];
    for (const row of rows) {
      if (!row || typeof row.uid !== 'number') continue;
      if (row.uid <= sinceUid) continue;
      out.push({
        uid: row.uid,
        from: formatFrom(row.envelope),
        subject: row.envelope?.subject ?? '',
        snippet: extractSnippet(row.bodyParts, SNIPPET_LEN),
        receivedAt: row.internalDate instanceof Date ? row.internalDate.getTime() : 0,
      });
    }
    return out;
  });
}

export async function fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage> {
  return withClient(account, async (client) => {
    const row = await client.fetchOne(uid, {
      envelope: true,
      internalDate: true,
      bodyParts: ['1'],
    });
    if (!row) throw new Error(`Message uid=${uid} not found in INBOX`);
    return {
      uid,
      from: formatFrom(row.envelope),
      subject: row.envelope?.subject ?? '',
      bodyText: extractSnippet(row.bodyParts, 50_000),
      receivedAt: row.internalDate instanceof Date ? row.internalDate.getTime() : 0,
    };
  });
}
```

- [x] **Step 5: Run — expect PASS**

Run: `npm -w @r2/server test -- imap-client.test`
Expected: 5 tests pass.

- [x] **Step 6: Commit**

```bash
git add packages/server/package.json package-lock.json packages/server/src/emails/imap-client.ts packages/server/src/emails/__tests__/imap-client.test.ts
git commit -m "feat(emails): add imapflow dependency and IMAP client wrapper"
```

---

## Task 5: LLM importance scorer

**Files:**
- Create: `packages/server/src/emails/scorer.ts`
- Create: `packages/server/src/emails/__tests__/scorer.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/emails/__tests__/scorer.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { PiiProxy } from '../../pii/proxy.js';
import { scoreBatch } from '../scorer.js';

function fakeProxy(): PiiProxy {
  return {
    async anonymize(text) { return { text, entities: [] }; },
    async deanonymize(text) { return text; },
  };
}

function fakeOllama(jsonReply: string) {
  return { chat: vi.fn(async () => ({ text: jsonReply })) } as any;
}

function fakeAnthropic(jsonReply: string) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: jsonReply }],
        role: 'assistant',
      })),
    },
  } as any;
}

const msgs = [
  { uid: 1, from: 'Bank', subject: 'Payment', snippet: 'you paid 100' },
  { uid: 2, from: 'Newsletter', subject: 'Weekly', snippet: 'promo' },
];

describe('scoreBatch', () => {
  it('parses clean JSON reply from Ollama', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":5},{"uid":2,"importance":1}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toEqual([
      { uid: 1, importance: 5 },
      { uid: 2, importance: 1 },
    ]);
  });

  it('strips fence markers around JSON', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('```json\n[{"uid":1,"importance":4},{"uid":2,"importance":2}]\n```'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.map((r) => r.importance)).toEqual([4, 2]);
  });

  it('clamps importance into 1..5', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":9},{"uid":2,"importance":-3}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res.map((r) => r.importance)).toEqual([5, 1]);
  });

  it('falls back to Claude when Ollama returns unparseable', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('not json at all'),
      anthropic: fakeAnthropic('[{"uid":1,"importance":3},{"uid":2,"importance":1}]'),
      signal: new AbortController().signal,
    });
    expect(res[0].importance).toBe(3);
    expect(res[1].importance).toBe(1);
  });

  it('returns importance=3 for uids missing from reply', async () => {
    const res = await scoreBatch(msgs, {
      piiProxy: fakeProxy(),
      ollama: fakeOllama('[{"uid":1,"importance":5}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toContainEqual({ uid: 2, importance: 3 });
  });

  it('returns empty array for empty input', async () => {
    const res = await scoreBatch([], {
      piiProxy: fakeProxy(),
      ollama: fakeOllama(''),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(res).toEqual([]);
  });

  it('anonymizes subject+snippet via piiProxy before LLM', async () => {
    const proxy = fakeProxy();
    const spy = vi.spyOn(proxy, 'anonymize');
    await scoreBatch(msgs, {
      piiProxy: proxy,
      ollama: fakeOllama('[{"uid":1,"importance":4},{"uid":2,"importance":2}]'),
      anthropic: fakeAnthropic(''),
      signal: new AbortController().signal,
    });
    expect(spy).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- scorer.test`

- [x] **Step 3: Implement `emails/scorer.ts`**

```typescript
import type Anthropic from '@anthropic-ai/sdk';
import type { PiiProxy } from '../pii/proxy.js';
import type { OllamaClient } from '../ai/ollama.js';

export interface ScorerDeps {
  piiProxy: PiiProxy;
  ollama: OllamaClient | null;
  anthropic: Anthropic;
  signal: AbortSignal;
}

interface MsgInput {
  uid: number;
  from: string;
  subject: string;
  snippet: string;
}

const SCORE_SYSTEM = `Ты фильтр входящей почты. Для каждого письма оцени importance по шкале 1-5:
1 — newsletter/promo/bulk (удаляется не читая).
2 — инфо без действий (order confirmation, system notice).
3 — стоит заметить, не срочно.
4 — требует ответа/действия (человек, приглашение, счёт, документ).
5 — срочное/критичное (банк, юридика, здоровье, deadline сегодня).
Отвечай ТОЛЬКО JSON массивом [{"uid":<int>,"importance":<1..5>}, ...]. Без текста вокруг.`;

const MAX_BATCH = 10;
const SNIPPET_CHARS = 300;

function buildPrompt(msgs: MsgInput[]): string {
  const payload = msgs.map((m) => ({
    uid: m.uid,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet.slice(0, SNIPPET_CHARS),
  }));
  return `Оцени важность писем:\n\n${JSON.stringify(payload, null, 2)}`;
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = candidate.trim();
  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart === -1 || bracketEnd === -1 || bracketEnd <= bracketStart) {
    throw new Error('no JSON array found');
  }
  return JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function normalize(raw: any, uids: number[]): Array<{ uid: number; importance: number }> {
  const byUid = new Map<number, number>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item.uid === 'number' && typeof item.importance === 'number') {
        byUid.set(item.uid, clamp(item.importance));
      }
    }
  }
  return uids.map((uid) => ({ uid, importance: byUid.get(uid) ?? 3 }));
}

async function callOllama(
  ollama: OllamaClient,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const r = await ollama.chat({
    messages: [{ role: 'user', content: userPrompt }],
    system: SCORE_SYSTEM,
    signal,
  });
  return r.text;
}

async function callClaude(
  anthropic: Anthropic,
  userPrompt: string,
  signal: AbortSignal,
): Promise<string> {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const msg = await anthropic.messages.create(
    {
      model,
      max_tokens: 512,
      system: SCORE_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { signal },
  );
  const block = (msg.content as any[]).find((b) => b.type === 'text');
  return block?.text ?? '';
}

export async function scoreBatch(
  msgs: MsgInput[],
  deps: ScorerDeps,
): Promise<Array<{ uid: number; importance: number }>> {
  if (msgs.length === 0) return [];
  const batches: MsgInput[][] = [];
  for (let i = 0; i < msgs.length; i += MAX_BATCH) {
    batches.push(msgs.slice(i, i + MAX_BATCH));
  }

  const result: Array<{ uid: number; importance: number }> = [];
  for (const batch of batches) {
    const anonymized: MsgInput[] = [];
    for (const m of batch) {
      const sub = await deps.piiProxy.anonymize(m.subject);
      const snip = await deps.piiProxy.anonymize(m.snippet);
      anonymized.push({ uid: m.uid, from: m.from, subject: sub.text, snippet: snip.text });
    }
    const prompt = buildPrompt(anonymized);

    let raw: string;
    let scored: Array<{ uid: number; importance: number }> | null = null;
    const useOllama = deps.ollama && (process.env.LOCAL_LLM_MODE || 'enabled') === 'enabled';
    if (useOllama) {
      try {
        raw = await callOllama(deps.ollama!, prompt, deps.signal);
        const parsed = extractJson(raw);
        scored = normalize(parsed, batch.map((m) => m.uid));
      } catch {
        scored = null;
      }
    }
    if (!scored) {
      try {
        raw = await callClaude(deps.anthropic, prompt, deps.signal);
        const parsed = extractJson(raw);
        scored = normalize(parsed, batch.map((m) => m.uid));
      } catch {
        // Final fallback: importance=3 for all
        scored = batch.map((m) => ({ uid: m.uid, importance: 3 }));
      }
    }
    result.push(...scored);
  }
  return result;
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- scorer.test`
Expected: 7 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/emails/scorer.ts packages/server/src/emails/__tests__/scorer.test.ts
git commit -m "feat(emails): add batched LLM importance scorer with Ollama→Claude fallback"
```

---

## Task 6: Multi-account poller

**Files:**
- Create: `packages/server/src/emails/multi-account-poller.ts`
- Create: `packages/server/src/emails/__tests__/multi-account-poller.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/emails/__tests__/multi-account-poller.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db.js';
import { createEmailStore } from '../store.js';
import { runPollTick } from '../multi-account-poller.js';
import type { ImapAccount, NewMessage } from '../types.js';

beforeEach(() => initDb(':memory:'));

const accA: ImapAccount = { id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true };
const accB: ImapAccount = { id: 'b', host: 'h2', port: 993, user: 'u', password: 'p', tls: true };

function msg(uid: number, from = 'x', subject = 's'): NewMessage {
  return { uid, from, subject, snippet: 'x', receivedAt: 1000 + uid };
}

describe('runPollTick', () => {
  it('inserts only score >= 4 and updates last_seen_uid', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => [msg(1), msg(2), msg(3)]);
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: m.uid === 2 ? 5 : 2 })),
    );

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      now: 5000,
    });

    expect(store.countPendingUndelivered()).toBe(1);
    const rows = store.fetchPendingUndelivered(10);
    expect(rows[0].message_uid).toBe(2);
    expect(store.getLastSeenUid('a')).toBe(3);
  });

  it('runs accounts in parallel and isolates errors per account', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async (acc: ImapAccount) => {
      if (acc.id === 'a') throw new Error('imap-down');
      return [msg(7)];
    });
    const scorer = vi.fn(async (ms: NewMessage[]) =>
      ms.map((m) => ({ uid: m.uid, importance: 5 })),
    );

    await runPollTick({
      accounts: [accA, accB],
      store,
      fetcher,
      scorer,
      now: 6000,
    });

    expect(store.getAccountError('a')?.message).toContain('imap-down');
    expect(store.getLastSeenUid('b')).toBe(7);
    expect(store.countPendingUndelivered()).toBe(1);
  });

  it('does NOT update last_seen_uid when scorer throws', async () => {
    const store = createEmailStore({ db: getDb() });
    store.updateLastSeenUid('a', 10, 1000);
    const fetcher = vi.fn(async () => [msg(11)]);
    const scorer = vi.fn(async () => { throw new Error('llm-down'); });

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      now: 7000,
    });

    expect(store.getLastSeenUid('a')).toBe(10);
    expect(store.countPendingUndelivered()).toBe(0);
    expect(store.getAccountError('a')?.message).toContain('llm-down');
  });

  it('skips accounts with no new messages silently', async () => {
    const store = createEmailStore({ db: getDb() });
    const fetcher = vi.fn(async () => []);
    const scorer = vi.fn(async () => []);

    await runPollTick({
      accounts: [accA],
      store,
      fetcher,
      scorer,
      now: 8000,
    });

    expect(scorer).not.toHaveBeenCalled();
    expect(store.getAccountError('a')).toBeNull();
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- multi-account-poller.test`

- [x] **Step 3: Implement `emails/multi-account-poller.ts`**

```typescript
import type { ImapAccount, NewMessage } from './types.js';
import type { EmailStore } from './store.js';

export type MessageFetcher = (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
export type MessageScorer = (msgs: NewMessage[]) => Promise<Array<{ uid: number; importance: number }>>;

interface TickParams {
  accounts: ImapAccount[];
  store: EmailStore;
  fetcher: MessageFetcher;
  scorer: MessageScorer;
  now: number;
  fetchLimit?: number;
  importanceCutoff?: number;
}

const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_CUTOFF = 4;

export async function runPollTick(params: TickParams): Promise<void> {
  const fetchLimit = params.fetchLimit ?? DEFAULT_FETCH_LIMIT;
  const cutoff = params.importanceCutoff ?? DEFAULT_CUTOFF;

  await Promise.all(
    params.accounts.map(async (acc) => {
      try {
        const sinceUid = params.store.getLastSeenUid(acc.id);
        const msgs = await params.fetcher(acc, sinceUid, fetchLimit);
        if (msgs.length === 0) return;

        const scored = await params.scorer(msgs);
        const byUid = new Map(scored.map((s) => [s.uid, s.importance]));

        for (const m of msgs) {
          const importance = byUid.get(m.uid) ?? 3;
          if (importance >= cutoff) {
            params.store.insertPending({
              account_id: acc.id,
              message_uid: m.uid,
              from_addr: m.from,
              subject: m.subject,
              snippet: m.snippet,
              importance,
              received_at: m.receivedAt,
              added_at: params.now,
            });
          }
        }

        const maxUid = msgs.reduce((m, x) => Math.max(m, x.uid), 0);
        if (maxUid > 0) {
          params.store.updateLastSeenUid(acc.id, maxUid, params.now);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        params.store.setAccountError(acc.id, msg, params.now);
      }
    }),
  );
}

interface StartParams extends Omit<TickParams, 'now'> {
  intervalMs: number;
}

export function startEmailPoller(params: StartParams): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runPollTick({ ...params, now: Date.now() });
    } catch (err) {
      console.error('[emails] poll tick crashed:', err instanceof Error ? err.message : err);
    }
  };
  // Run once at start for immediate pickup, then on interval.
  void tick();
  const timer = setInterval(() => void tick(), params.intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- multi-account-poller.test`
Expected: 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/emails/multi-account-poller.ts packages/server/src/emails/__tests__/multi-account-poller.test.ts
git commit -m "feat(emails): add multi-account poller with per-account error isolation"
```

---

## Task 7: emailDigest helpers (quiet hours, morning-brief hold, formatter)

**Files:**
- Create: `packages/server/src/cognition/handlers/emailDigest.helpers.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/emailDigest.helpers.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/cognition/__tests__/handlers/emailDigest.helpers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import {
  inQuietHours,
  morningBriefPublishedToday,
  formatDigest,
} from '../../handlers/emailDigest.helpers.js';

beforeEach(() => initDb(':memory:'));

const TZ = 'Europe/Kyiv';

function epochAtKyiv(year: number, month: number, day: number, hour: number): number {
  // Build an approximate Kyiv-local epoch. Kyiv is UTC+2 (or +3 in DST).
  // For test stability we use April (DST=on, UTC+3).
  const utcHour = hour - 3;
  return Date.UTC(year, month - 1, day, utcHour, 0, 0);
}

function insertRun(handlerName: string, firedAt: number, outcome: 'publish' | 'skip' | 'error') {
  getDb().prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
  ).run(handlerName, firedAt, 10, outcome);
}

describe('inQuietHours', () => {
  it('returns true at 23:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 23);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('returns true at 04:00 local (past midnight)', () => {
    const now = epochAtKyiv(2026, 4, 24, 4);
    expect(inQuietHours(now, 22, TZ)).toBe(true);
  });

  it('returns false at 14:00 local', () => {
    const now = epochAtKyiv(2026, 4, 24, 14);
    expect(inQuietHours(now, 22, TZ)).toBe(false);
  });
});

describe('morningBriefPublishedToday', () => {
  it('returns false when no runs', () => {
    const now = epochAtKyiv(2026, 4, 24, 10);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns true when morningBrief published earlier today', () => {
    const pubAt = epochAtKyiv(2026, 4, 24, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(true);
  });

  it('returns false when last publish was yesterday', () => {
    const pubAt = epochAtKyiv(2026, 4, 23, 7);
    insertRun('morningBrief', pubAt, 'publish');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });

  it('returns false when only "skip" or "error" outcomes exist today', () => {
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 7), 'skip');
    insertRun('morningBrief', epochAtKyiv(2026, 4, 24, 8), 'error');
    const now = epochAtKyiv(2026, 4, 24, 11);
    expect(morningBriefPublishedToday(getDb(), now, TZ)).toBe(false);
  });
});

describe('formatDigest', () => {
  const mk = (importance: number, from = 'Alice <a@b.com>', subject = 'Hi', snippet = 'Hello world') => ({
    id: 1, account_id: 'acc', message_uid: 1, from_addr: from, subject, snippet,
    importance, received_at: 1000, added_at: 1000, delivered_at: null,
  });

  it('renders count line + emoji + score + sender + summary', () => {
    const out = formatDigest([mk(5), mk(4, 'Bob <b@c>', 'Call', 'let us meet tomorrow')]);
    expect(out).toContain('📬');
    expect(out).toContain('2 важных');
    expect(out).toContain('🔴 [5]');
    expect(out).toContain('🟠 [4]');
    expect(out).toContain('Alice');
    expect(out).toContain('Bob');
  });

  it('truncates snippet to 140 chars', () => {
    const long = 'x'.repeat(300);
    const out = formatDigest([mk(5, 'A <a@b>', 'S', long)]);
    const line = out.split('\n').find((l) => l.includes('[5]'))!;
    expect(line.length).toBeLessThan(300);
  });

  it('returns under 2000 chars and appends "…ещё N" tail when overflowing', () => {
    const many = Array.from({ length: 50 }, (_, i) => mk(5, `X${i} <x@y>`, `S${i}`, 'a'.repeat(100)));
    const out = formatDigest(many);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toMatch(/ещё\s+\d+\s+писем/);
  });

  it('strips <email> tail from sender', () => {
    const out = formatDigest([mk(5, 'Alice <alice@bank.com>', 'S', 'txt')]);
    expect(out).toContain('Alice');
    expect(out).not.toContain('<alice@bank.com>');
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- emailDigest.helpers.test`

- [x] **Step 3: Implement `cognition/handlers/emailDigest.helpers.ts`**

```typescript
import type Database from 'better-sqlite3';
import type { EmailPendingRow } from '../../emails/types.js';

const DISCORD_MAX = 2000;
const SUMMARY_CHARS = 140;

function localParts(epochMs: number, tz: string): { year: number; month: number; day: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
  };
}

function sameLocalDay(a: number, b: number, tz: string): boolean {
  const pa = localParts(a, tz);
  const pb = localParts(b, tz);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

export function inQuietHours(now: number, quietStart: number, tz: string): boolean {
  const { hour } = localParts(now, tz);
  // Quiet window: [quietStart, 24) ∪ [0, quietStart). Since "end" is
  // determined by morning-brief publish (separate check), the "after
  // midnight" part is also quiet until morning-brief releases. So: any hour
  // >= quietStart OR hour < quietStart-12 is quiet. Simpler rule: consider
  // anything outside "daytime window" [quietStart-12 .. quietStart) quiet,
  // but callers layer morning-brief check on top. Here we just say:
  // hour >= quietStart is quiet (evening), hour < 10 also quiet (early morning).
  return hour >= quietStart || hour < 10;
}

export function morningBriefPublishedToday(db: Database.Database, now: number, tz: string): boolean {
  const row = db
    .prepare(
      "SELECT MAX(fired_at) AS ts FROM cognition_handler_runs WHERE handler_name='morningBrief' AND outcome='publish'",
    )
    .get() as { ts: number | null } | undefined;
  if (!row?.ts) return false;
  return sameLocalDay(row.ts, now, tz);
}

function cleanSender(from: string): string {
  // "Alice <alice@bank.com>" → "Alice"
  // "alice@bank.com" → "alice@bank.com"
  const m = from.match(/^(.+?)\s*<[^>]+>$/);
  if (m && m[1].trim()) return m[1].trim();
  return from;
}

function emojiFor(importance: number): string {
  if (importance >= 5) return '🔴';
  if (importance >= 4) return '🟠';
  return '🟡';
}

function line(row: EmailPendingRow): string {
  const sender = cleanSender(row.from_addr);
  const subject = (row.subject || '(без темы)').replace(/\s+/g, ' ').trim();
  const summary = (row.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS);
  return `${emojiFor(row.importance)} [${row.importance}] ${sender} — ${subject}: ${summary}`;
}

export function formatDigest(rows: EmailPendingRow[]): string {
  const header = `📬 ${rows.length} важных писем`;
  const lines: string[] = [header, ''];
  let used = header.length + 2;
  let included = 0;

  for (const r of rows) {
    const ln = line(r);
    // Keep a budget for possible "…ещё N писем" tail (~50 chars).
    if (used + ln.length + 1 + 50 > DISCORD_MAX && rows.length - included > 1) break;
    lines.push(ln);
    used += ln.length + 1;
    included += 1;
  }

  if (included < rows.length) {
    lines.push('');
    lines.push(`…ещё ${rows.length - included} писем`);
  }

  return lines.join('\n');
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- emailDigest.helpers.test`
Expected: 11 tests pass (some DST edge cases may be sensitive — tolerate if timezone constants need adjustment, re-check with actual `Intl.DateTimeFormat` output).

- [x] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/emailDigest.helpers.ts packages/server/src/cognition/__tests__/handlers/emailDigest.helpers.test.ts
git commit -m "feat(emails): add emailDigest helpers (quiet hours, brief-hold, formatter)"
```

---

## Task 8: emailDigest cognition handler

**Files:**
- Create: `packages/server/src/cognition/handlers/emailDigest.ts`
- Create: `packages/server/src/cognition/__tests__/handlers/emailDigest.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/server/src/cognition/__tests__/handlers/emailDigest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../../db.js';
import { createEmailStore } from '../../../emails/store.js';
import { createEmailDigestHandler } from '../../handlers/emailDigest.js';

beforeEach(() => initDb(':memory:'));

function mkCtx(firedAt: number) {
  return { db: getDb(), firedAt, signal: new AbortController().signal };
}

function mkPending(opts: { uid: number; importance: number; received_at: number }) {
  getDb().prepare(`
    INSERT INTO email_pending (account_id, message_uid, from_addr, subject, snippet, importance, received_at, added_at)
    VALUES ('a', ?, 'x@y', 's', 'snip', ?, ?, ?)
  `).run(opts.uid, opts.importance, opts.received_at, opts.received_at);
}

function markBriefPublished(at: number) {
  getDb().prepare(
    'INSERT INTO cognition_handler_runs (handler_name, fired_at, duration_ms, outcome) VALUES (?, ?, ?, ?)',
  ).run('morningBrief', at, 10, 'publish');
}

const TZ = 'Europe/Kyiv';

describe('createEmailDigestHandler.trigger', () => {
  it('returns false when pending < threshold', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 3, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false during quiet hours (22:00 local)', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 23 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false when morning-brief has not published today', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 11 - 3);
    // No brief publish today
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(false);
  });

  it('returns false inside cooldown', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 60 * 60_000, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger(
      { now, lastFiredAt: now - 60_000, lastResult: { publish: true, content: 'x' } },
      { db: getDb() },
    );
    expect(fire).toBe(false);
  });

  it('returns true when threshold met, not quiet, brief-published, cooldown elapsed', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 2, cooldownMs: 100, quietStart: 22 });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 5, received_at: 1000 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    markBriefPublished(Date.UTC(2026, 3, 24, 8 - 3));
    const fire = await h.trigger({ now, lastFiredAt: null, lastResult: null }, { db: getDb() });
    expect(fire).toBe(true);
  });
});

describe('createEmailDigestHandler.run', () => {
  it('returns skip when no pending rows', async () => {
    const store = createEmailStore({ db: getDb() });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const res = await h.run(mkCtx(Date.now()));
    expect(res).toEqual({ skip: true, reason: 'no pending' });
  });

  it('publishes digest and marks rows delivered', async () => {
    const store = createEmailStore({ db: getDb() });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    mkPending({ uid: 2, importance: 4, received_at: 1000 });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    const res = await h.run(mkCtx(now));
    expect('publish' in res && res.publish).toBe(true);
    expect(store.countPendingUndelivered()).toBe(0);
  });

  it('re-run after publish returns skip (markDelivered is idempotent)', async () => {
    const store = createEmailStore({ db: getDb() });
    mkPending({ uid: 1, importance: 5, received_at: 1000 });
    const h = createEmailDigestHandler({ store, tz: TZ, threshold: 1, cooldownMs: 100, quietStart: 22 });
    const now = Date.UTC(2026, 3, 24, 12 - 3);
    await h.run(mkCtx(now));
    const again = await h.run(mkCtx(now + 1000));
    expect(again).toEqual({ skip: true, reason: 'no pending' });
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/server test -- emailDigest.test`

- [x] **Step 3: Implement `cognition/handlers/emailDigest.ts`**

```typescript
import type { Handler } from '../types.js';
import type { EmailStore } from '../../emails/store.js';
import {
  inQuietHours,
  morningBriefPublishedToday,
  formatDigest,
} from './emailDigest.helpers.js';

interface Deps {
  store: EmailStore;
  tz: string;
  threshold: number;
  cooldownMs: number;
  quietStart: number;
  maxRows?: number;
}

export function createEmailDigestHandler(deps: Deps): Handler {
  const maxRows = deps.maxRows ?? 50;
  return {
    name: 'emailDigest',
    async trigger(state, ctx) {
      if (deps.store.countPendingUndelivered() < deps.threshold) return false;
      if (inQuietHours(state.now, deps.quietStart, deps.tz)) return false;
      if (!morningBriefPublishedToday(ctx.db, state.now, deps.tz)) return false;
      if (state.lastFiredAt && state.now - state.lastFiredAt < deps.cooldownMs) return false;
      return true;
    },
    async run(ctx) {
      try {
        const pending = deps.store.fetchPendingUndelivered(maxRows);
        if (pending.length === 0) return { skip: true, reason: 'no pending' };
        const content = formatDigest(pending);
        deps.store.markDelivered(pending.map((r) => r.id), ctx.firedAt);
        return { publish: true, content };
      } catch (err) {
        return {
          error: true,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/server test -- emailDigest.test`
Expected: 8 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/cognition/handlers/emailDigest.ts packages/server/src/cognition/__tests__/handlers/emailDigest.test.ts
git commit -m "feat(emails): add emailDigest cognition handler (trigger + run)"
```

---

## Task 9: Wire poller + handler into server/index.ts

**Files:**
- Modify: `packages/server/src/index.ts`

- [x] **Step 1: Read the registration block for morningBrief**

Examine `packages/server/src/index.ts` lines ~260-320 where `startDiscordBot` + `cognitionService.register(createMorningBriefHandler(...))` happens. New code goes immediately after.

- [x] **Step 2: Add imports at the top of `index.ts`**

Add near existing `createMorningBriefHandler` import:

```typescript
import { parseImapAccounts } from './emails/config.js';
import { createEmailStore } from './emails/store.js';
import { fetchNewMessages, fetchFullBody } from './emails/imap-client.js';
import { scoreBatch } from './emails/scorer.js';
import { startEmailPoller } from './emails/multi-account-poller.js';
import { createEmailDigestHandler } from './cognition/handlers/emailDigest.js';
```

- [x] **Step 3: Parse accounts + init store early (before tool discovery)**

After `const reminderStore = createReminderStore(...)` and before `discoverTools`, add:

```typescript
const emailStore = createEmailStore({ db: getDb() });
const imapAccounts = (() => {
  try { return parseImapAccounts(process.env.IMAP_ACCOUNTS); }
  catch (err) {
    console.error('[emails] IMAP_ACCOUNTS invalid:', err instanceof Error ? err.message : err);
    return [];
  }
})();
const emailEnabled = (process.env.EMAIL_ENABLED || 'true') !== 'false' && imapAccounts.length > 0;
const imapClientForTool = {
  fetchNewMessages,
  fetchFullBody,
  getAccount: (id: string) => imapAccounts.find((a) => a.id === id) ?? null,
};
```

- [x] **Step 4: Pass `emailStore` + `imapClientForTool` to `discoverTools`**

Update the `discoverTools` call to include:

```typescript
await discoverTools(registry, {
  runLoop: runLoopFn,
  client,
  registry,
  piiProxy,
  memoryService,
  reminderStore,
  emailStore,
  imapClient: imapClientForTool,
});
```

(ToolDeps extension is in Task 13.)

- [x] **Step 5: Start poller + register handler after Discord bot started**

In the existing `if (discordToken) { ... }` block, right after `cognitionService.register(createMorningBriefHandler({ ... }))`, add:

```typescript
if (emailEnabled) {
  const stopEmailPoller = startEmailPoller({
    accounts: imapAccounts,
    store: emailStore,
    fetcher: (acc, sinceUid, limit) => fetchNewMessages(acc, sinceUid, limit),
    scorer: (msgs) =>
      scoreBatch(msgs, {
        piiProxy,
        ollama: ollamaForMemory ?? null,
        anthropic: client as any,
        signal: new AbortController().signal,
      }),
    intervalMs: Number(process.env.EMAIL_POLL_INTERVAL_MS) || 300_000,
  });
  cognitionService.register(
    createEmailDigestHandler({
      store: emailStore,
      tz: 'Europe/Kyiv',
      threshold: Number(process.env.EMAIL_DIGEST_THRESHOLD) || 3,
      cooldownMs: Number(process.env.EMAIL_DIGEST_COOLDOWN_MS) || 7200_000,
      quietStart: Number(process.env.EMAIL_QUIET_HOUR_START) || 22,
    }),
  );
  process.on('beforeExit', () => stopEmailPoller());
  console.log(`[emails] poller started for ${imapAccounts.length} account(s)`);
} else {
  console.log('[emails] disabled (EMAIL_ENABLED=false or IMAP_ACCOUNTS empty)');
}
```

- [x] **Step 6: Type-check the server package**

Run: `npm -w @r2/server run build`
Expected: no type errors. If `ToolDeps` complains, proceed to Task 13 first (or perform the type extension in this task).

- [x] **Step 7: Commit**

```bash
git add packages/server/src/index.ts
git commit -m "feat(emails): wire poller + emailDigest handler into server bootstrap"
```

---

## Task 10: Create `@r2/tool-emails` package

**Files:**
- Create: `packages/tool-emails/package.json`
- Create: `packages/tool-emails/tsconfig.json`
- Create: `packages/tool-emails/src/types.ts`
- Create: `packages/tool-emails/src/index.ts` (stub export)

- [x] **Step 1: Create package.json**

```json
{
  "name": "@r2/tool-emails",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^1.0.0"
  }
}
```

(Adjust vitest version to match `packages/server/package.json` root once verified with `npm ls vitest -w @r2/server`.)

- [x] **Step 2: Create tsconfig.json — copy from `packages/tool-reminder/tsconfig.json`**

```bash
cp packages/tool-reminder/tsconfig.json packages/tool-emails/tsconfig.json
```

- [x] **Step 3: Create `src/types.ts` with dep interfaces**

```typescript
import type { ImapAccount, FullMessage, EmailPendingRow } from '../../server/src/emails/types.js';

// NOTE: importing across package boundary via relative path keeps types in sync
// without publishing a shared-emails package. If boundary hygiene becomes an
// issue, lift these types into @r2/shared.

export interface EmailStoreLike {
  fetchInWindow(sinceHours: number, limit: number, now: number): EmailPendingRow[];
  findByPendingId(id: number): EmailPendingRow | null;
}

export interface ImapClientLike {
  fetchFullBody(account: ImapAccount, uid: number): Promise<FullMessage>;
  getAccount(id: string): ImapAccount | null;
}
```

- [x] **Step 4: Create `src/index.ts` stub**

```typescript
import type { ToolDefinition } from '@r2/shared';
import type { EmailStoreLike, ImapClientLike } from './types.js';

interface Deps {
  emailStore: EmailStoreLike | null;
  imapClient: ImapClientLike | null;
}

export function createTool(_deps: Deps): ToolDefinition[] {
  return [];
}
export default createTool;
```

- [x] **Step 5: Install workspace + verify resolution**

Run: `npm install`
Expected: `@r2/tool-emails` shows up via workspace symlink.

- [x] **Step 6: Commit**

```bash
git add packages/tool-emails/package.json packages/tool-emails/tsconfig.json packages/tool-emails/src/types.ts packages/tool-emails/src/index.ts package-lock.json
git commit -m "feat(tool-emails): scaffold @r2/tool-emails package"
```

---

## Task 11: Implement `emails_list` tool

**Files:**
- Modify: `packages/tool-emails/src/index.ts`
- Create: `packages/tool-emails/src/__tests__/index.test.ts`

- [x] **Step 1: Write failing test**

Create `packages/tool-emails/src/__tests__/index.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTool } from '../index.js';
import type { EmailStoreLike, ImapClientLike } from '../types.js';

function mkRow(id: number, importance: number, delivered = false) {
  return {
    id, account_id: 'a', message_uid: id, from_addr: 'A <a@b>',
    subject: 'S', snippet: 'x', importance,
    received_at: 1000 + id, added_at: 1000 + id,
    delivered_at: delivered ? 2000 : null,
  };
}

function mkStore(rows: any[]): EmailStoreLike {
  return {
    fetchInWindow: vi.fn((_h: number, _l: number, _now: number) => rows),
    findByPendingId: vi.fn((id: number) => rows.find((r) => r.id === id) ?? null),
  };
}

function mkImap(overrides: Partial<ImapClientLike> = {}): ImapClientLike {
  return {
    fetchFullBody: vi.fn(),
    getAccount: vi.fn(() => ({ id: 'a', host: 'h', port: 993, user: 'u', password: 'p', tls: true })),
    ...overrides,
  };
}

describe('emails_list tool', () => {
  it('returns JSON array of rows', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(1, 5), mkRow(2, 4, true)]),
      imapClient: mkImap(),
    });
    const list = tools.find((t) => t.name === 'emails_list')!;
    const res = await list.handler({});
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output as string);
    expect(data).toHaveLength(2);
    expect(data[0]).toHaveProperty('importance');
    expect(data[0]).toHaveProperty('delivered');
  });

  it('honours limit (default 10, max 50)', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => mkRow(i + 1, 4));
    const store = mkStore(rows);
    const tools = createTool({ emailStore: store, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;

    await list.handler({});
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(72, 10, expect.any(Number));

    await list.handler({ limit: 500 });
    expect(store.fetchInWindow).toHaveBeenLastCalledWith(72, 50, expect.any(Number));
  });

  it('returns error when emailStore is null', async () => {
    const tools = createTool({ emailStore: null, imapClient: mkImap() });
    const list = tools.find((t) => t.name === 'emails_list')!;
    const res = await list.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/email/i);
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/tool-emails test`

- [x] **Step 3: Implement `emails_list` in `src/index.ts`**

Replace the stub:

```typescript
import type { ToolDefinition, ToolResult } from '@r2/shared';
import type { EmailStoreLike, ImapClientLike } from './types.js';

interface Deps {
  emailStore: EmailStoreLike | null;
  imapClient: ImapClientLike | null;
}

function toListItem(row: any) {
  return {
    id: row.id,
    account_id: row.account_id,
    from: row.from_addr,
    subject: row.subject,
    snippet: row.snippet,
    importance: row.importance,
    received_at: row.received_at,
    delivered: row.delivered_at !== null,
  };
}

function createEmailsListTool(deps: Deps): ToolDefinition {
  return {
    name: 'emails_list',
    description:
      'Вернуть последние важные письма из всех подключённых ящиков, отсортированные по приоритету и времени. Используй когда юзер спрашивает "что в почте", "новые письма", "покажи важное". Возвращает JSON массив.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Максимум писем (default 10, max 50)' },
        since_hours: { type: 'number', description: 'За сколько часов назад смотреть (default 72, max 720)' },
      },
    },
    command: {
      name: 'почта',
      description: 'Список важных писем',
      params: [],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.emailStore) {
        return { success: false, error: 'Email integration is not enabled on this server' };
      }
      const rawLimit = Number(params.limit);
      const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 10, 1), 50);
      const rawHours = Number(params.since_hours);
      const sinceHours = Math.min(Math.max(Number.isFinite(rawHours) ? Math.floor(rawHours) : 72, 1), 720);
      const rows = deps.emailStore.fetchInWindow(sinceHours, limit, Date.now());
      return { success: true, output: JSON.stringify(rows.map(toListItem)) };
    },
  };
}

export function createTool(deps: Deps): ToolDefinition[] {
  return [createEmailsListTool(deps)];
}
export default createTool;
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/tool-emails test`
Expected: 3 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/tool-emails/src/index.ts packages/tool-emails/src/__tests__/index.test.ts
git commit -m "feat(tool-emails): implement emails_list tool"
```

---

## Task 12: Implement `emails_get` tool

**Files:**
- Modify: `packages/tool-emails/src/index.ts`
- Modify: `packages/tool-emails/src/__tests__/index.test.ts`

- [x] **Step 1: Append failing tests**

Append to `index.test.ts`:

```typescript
describe('emails_get tool', () => {
  it('returns full body for known id', async () => {
    const rows = [mkRow(5, 5)];
    const fetchFullBody = vi.fn(async () => ({
      uid: 5, from: 'A <a@b>', subject: 'S', bodyText: 'Full body here', receivedAt: 1000,
    }));
    const tools = createTool({
      emailStore: mkStore(rows),
      imapClient: mkImap({ fetchFullBody }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output as string);
    expect(data.body_text).toBe('Full body here');
  });

  it('returns error when id unknown', async () => {
    const tools = createTool({
      emailStore: mkStore([]),
      imapClient: mkImap(),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 999 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it('returns error when account missing', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(5, 5)]),
      imapClient: mkImap({ getAccount: () => null }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/account/i);
  });

  it('propagates IMAP fetch failure', async () => {
    const tools = createTool({
      emailStore: mkStore([mkRow(5, 5)]),
      imapClient: mkImap({ fetchFullBody: vi.fn(async () => { throw new Error('boom'); }) }),
    });
    const get = tools.find((t) => t.name === 'emails_get')!;
    const res = await get.handler({ id: 5 });
    expect(res.success).toBe(false);
    expect(res.error).toContain('boom');
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `npm -w @r2/tool-emails test`

- [x] **Step 3: Implement `emails_get` in `src/index.ts`**

Add above `export function createTool(...)`:

```typescript
function createEmailsGetTool(deps: Deps): ToolDefinition {
  return {
    name: 'emails_get',
    description:
      'Получить полное тело письма по id (берёшь id из результата emails_list). Делает запрос к IMAP, не кешируется. Используй когда юзер просит показать или разобрать конкретное письмо.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'id записи из emails_list' },
      },
      required: ['id'],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      if (!deps.emailStore || !deps.imapClient) {
        return { success: false, error: 'Email integration is not enabled on this server' };
      }
      const id = Number(params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return { success: false, error: 'id must be a positive number' };
      }
      const row = deps.emailStore.findByPendingId(id);
      if (!row) return { success: false, error: `Email with id=${id} not found` };
      const account = deps.imapClient.getAccount(row.account_id);
      if (!account) return { success: false, error: `Account "${row.account_id}" is no longer configured` };
      try {
        const full = await deps.imapClient.fetchFullBody(account, row.message_uid);
        return {
          success: true,
          output: JSON.stringify({
            id: row.id,
            from: full.from,
            subject: full.subject,
            received_at: full.receivedAt,
            body_text: full.bodyText,
          }),
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

Update `createTool`:

```typescript
export function createTool(deps: Deps): ToolDefinition[] {
  return [createEmailsListTool(deps), createEmailsGetTool(deps)];
}
```

- [x] **Step 4: Run — expect PASS**

Run: `npm -w @r2/tool-emails test`
Expected: 4 new tests pass (7 total in file).

- [x] **Step 5: Commit**

```bash
git add packages/tool-emails/src/index.ts packages/tool-emails/src/__tests__/index.test.ts
git commit -m "feat(tool-emails): implement emails_get tool"
```

---

## Task 13: Extend `ToolDeps` and verify tool discovery

**Files:**
- Modify: `packages/server/src/tools/base.ts`
- Modify: `packages/server/src/tools/__tests__/registry.test.ts` (optional — add emails_list discovery assertion)

- [x] **Step 1: Extend `ToolDeps`**

In `packages/server/src/tools/base.ts`, add imports and extend interface:

```typescript
import type { EmailStore } from '../emails/store.js';
import type { ImapAccount, FullMessage, NewMessage } from '../emails/types.js';

export interface ImapClient {
  fetchNewMessages: (account: ImapAccount, sinceUid: number, limit: number) => Promise<NewMessage[]>;
  fetchFullBody: (account: ImapAccount, uid: number) => Promise<FullMessage>;
  getAccount: (id: string) => ImapAccount | null;
}

export interface ToolDeps {
  runLoop: RunLoopFn;
  client: ClaudeClient;
  registry: ToolRegistry;
  piiProxy: PiiProxy;
  memoryService: MemoryService | null;
  reminderStore: ReminderStore | null;
  emailStore: EmailStore | null;
  imapClient: ImapClient | null;
}
```

- [x] **Step 2: Rebuild + type-check**

Run: `npm -w @r2/server run build`
Expected: no type errors.

- [x] **Step 3: Add discovery assertion (optional but recommended)**

In `packages/server/src/tools/__tests__/registry.test.ts`, append:

```typescript
it('discovers emails_list and emails_get when deps are provided', async () => {
  const reg = await discoverTools(undefined, {
    runLoop: vi.fn() as any,
    client: {} as any,
    registry: createRegistry(),
    piiProxy: { async anonymize(t: string) { return { text: t, entities: [] }; }, async deanonymize(t: string) { return t; } } as any,
    memoryService: null,
    reminderStore: null,
    emailStore: {
      fetchInWindow: () => [],
      findByPendingId: () => null,
      getLastSeenUid: () => 0,
      updateLastSeenUid: () => {},
      setAccountError: () => {},
      getAccountError: () => null,
      insertPending: () => {},
      countPendingUndelivered: () => 0,
      fetchPendingUndelivered: () => [],
      markDelivered: () => {},
    } as any,
    imapClient: {
      fetchNewMessages: async () => [],
      fetchFullBody: async () => { throw new Error(); },
      getAccount: () => null,
    },
  });
  expect(reg.get('emails_list')).toBeTruthy();
  expect(reg.get('emails_get')).toBeTruthy();
});
```

- [x] **Step 4: Run tests**

Run: `npm -w @r2/server test`
Expected: all tests pass including new discovery test.

- [x] **Step 5: Commit**

```bash
git add packages/server/src/tools/base.ts packages/server/src/tools/__tests__/registry.test.ts
git commit -m "feat(tool-emails): wire emailStore + imapClient through ToolDeps"
```

---

## Task 14: Documentation + manual smoke checklist

**Files:**
- Modify: `.env.example` (or create if absent)
- Modify: `README.md` or `docs/ops/env.md` (whichever holds env docs)

- [x] **Step 1: Add env entries to `.env.example`**

Append:

```
# ---- Emails (Phase 4F) ----
# JSON array of IMAP accounts; empty/missing disables the feature.
# For Gmail: enable 2FA, generate app-password (https://myaccount.google.com/apppasswords)
# For iCloud: https://support.apple.com/en-us/102654
IMAP_ACCOUNTS=[]
EMAIL_ENABLED=true
EMAIL_POLL_INTERVAL_MS=300000
EMAIL_DIGEST_THRESHOLD=3
EMAIL_DIGEST_COOLDOWN_MS=7200000
EMAIL_QUIET_HOUR_START=22
```

- [x] **Step 2: Add smoke-test checklist to the spec file**

Append a new section to `docs/superpowers/specs/2026-04-24-email-watcher-design.md`:

```markdown
## Smoke test checklist (after deploy)

- [ ] `IMAP_ACCOUNTS=[{...one gmail...}]` — server boots, log `[emails] poller started for 1 account(s)`
- [ ] After 5 min tick, no errors in console, `SELECT * FROM email_account_state` shows `last_poll_at`
- [ ] Send a test email to yourself → next tick picks it up, LLM scores it, if ≥4 lands in `email_pending`
- [ ] `/почта` slash command in Discord → R2 returns a list via `emails_list`
- [ ] Force threshold: set `EMAIL_DIGEST_THRESHOLD=1`, wait for morning-brief publish, next cognition tick → digest lands in Discord
- [ ] Verify `delivered_at` populated after digest publish
- [ ] Add second account, restart → both poll in parallel
- [ ] Intentionally break one account's password → `last_error` logged, other accounts unaffected
```

- [x] **Step 3: Commit**

```bash
git add .env.example docs/superpowers/specs/2026-04-24-email-watcher-design.md
git commit -m "docs(emails): add env.example entries and smoke test checklist"
```

---

## Task 15: Full regression + merge to dev

- [x] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all packages green. If any pre-existing tests flake, investigate but don't fix unrelated.

Result (2026-04-24): 86 test files, 940 tests — all green.

- [x] **Step 2: Build the server package**

```bash
npm -w @r2/server run build
```

Expected: clean TypeScript compile.

Result (2026-04-24): `tsc` exit 0, dist/ populated.

- [x] **Step 3: Manual dry-run (no real accounts)**

With `IMAP_ACCOUNTS=[]`:

```bash
npm -w @r2/server run dev
```

Expected log lines:
- `[emails] disabled (EMAIL_ENABLED=false or IMAP_ACCOUNTS empty)`
- Tool discovery logs `emails_list` and `emails_get`

Kill server (Ctrl+C).

Result (2026-04-24): server booted on http://localhost:3004; tool discovery logged `emails_list` and `emails_get`; no errors. Note: `[emails] disabled ...` log is emitted only when `DISCORD_BOT_TOKEN` is set (it sits inside the Discord bot init block), so with an empty token it is gated out — expected.

- [x] **Step 4: Merge to dev branch per project flow**

```bash
# On the feature branch
git checkout dev
git pull
git merge --no-ff <feature-branch>
git push origin dev
```

(Per memory: feature→dev→master, supervisor auto-restart.)

Result (2026-04-24): merged `feature/email-watcher` into `dev` locally with `--no-ff`. No `origin` remote is configured on this checkout, so `git pull` and `git push origin dev` were skipped — the `dev` branch now contains all 15 email-watcher commits and can be synced upstream separately when a remote is wired in.

---

## Self-Review Notes

- **Spec coverage**
  - Scope "In" → tasks 1-14 cover all 7 bullet points.
  - IMAP poller multi-account: task 6.
  - LLM scoring: task 5.
  - `email_pending` table + index: task 1.
  - `emailDigest` with threshold+quiet+cooldown+brief-hold: tasks 7-8.
  - Discord digest formatter: task 7.
  - `emails_list` + `emails_get`: tasks 10-12.
  - Kill switch: task 9 (`EMAIL_ENABLED`), task 14 (env docs).

- **Placeholder scan** — pass. Every step has full code blocks or exact commands.

- **Type consistency** — `EmailPendingRow`, `ImapAccount`, `NewMessage`, `FullMessage` declared in task 2; used consistently in tasks 3, 4, 6, 7, 8, 10, 13.

- **Risk notes** — `imapflow` API surface (`search`, `fetchAll`, `bodyParts`) is stable per v1.x. If `bodyParts` structure differs in installed version, adjust `extractSnippet` in task 4 step 4 (only file that cares).

- **Open questions (carry-over from spec)** — addressed via env-configurable defaults (quiet hours, threshold, cooldown). No task blocked.
