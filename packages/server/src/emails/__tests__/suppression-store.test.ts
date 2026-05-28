import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createEmailSuppressionStore } from '../suppression-store.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('createEmailSuppressionStore', () => {
  describe('insertRule', () => {
    it('writes a sender row with computed expires_at when ttl_days given', () => {
      vi.useFakeTimers();
      const now = 1_700_000_000_000;
      vi.setSystemTime(now);
      const store = createEmailSuppressionStore({ db: getDb() });

      const inserted = store.insertRule({
        rule_type: 'sender',
        pattern: 'alerts@bank.com',
        ttl_days: 7,
      });

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.expires_at).toBe(now + 7 * 86400_000);

      const row = getDb()
        .prepare('SELECT * FROM email_suppression_rules WHERE id = ?')
        .get(inserted.id) as {
          rule_type: string;
          pattern: string;
          created_at: number;
          expires_at: number | null;
          created_via: string;
        };
      expect(row.rule_type).toBe('sender');
      expect(row.pattern).toBe('alerts@bank.com');
      expect(row.created_at).toBe(now);
      expect(row.expires_at).toBe(now + 7 * 86400_000);
      expect(row.created_via).toBe('discord_button');
    });

    it('writes a subject row with NULL expires_at when ttl_days is null (forever)', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      const inserted = store.insertRule({
        rule_type: 'subject',
        pattern: 'Order shipped',
        ttl_days: null,
      });
      expect(inserted.expires_at).toBeNull();
      const row = getDb()
        .prepare('SELECT expires_at FROM email_suppression_rules WHERE id = ?')
        .get(inserted.id) as { expires_at: number | null };
      expect(row.expires_at).toBeNull();
    });
  });

  describe('findActiveMatch', () => {
    it('returns null on empty table', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      expect(store.findActiveMatch('a@b.com', 'hello', Date.now())).toBeNull();
    });

    it('matches by exact sender', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'sender', pattern: 'alerts@bank.com', ttl_days: 7 });
      const hit = store.findActiveMatch('alerts@bank.com', 'whatever', Date.now());
      expect(hit).not.toBeNull();
      expect(hit?.rule_type).toBe('sender');
      expect(hit?.pattern).toBe('alerts@bank.com');
    });

    it('does not match sender with different address', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'sender', pattern: 'alerts@bank.com', ttl_days: 7 });
      expect(store.findActiveMatch('other@bank.com', 'whatever', Date.now())).toBeNull();
    });

    it('matches subject via case-insensitive substring', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'subject', pattern: 'Order Shipped', ttl_days: 7 });
      const hit = store.findActiveMatch('any@x.com', 'Your order shipped today', Date.now());
      expect(hit).not.toBeNull();
      expect(hit?.rule_type).toBe('subject');
    });

    it('matches subject case-insensitively for Cyrillic (Unicode lower)', () => {
      // Regression: SQLite's built-in `lower()` is ASCII-only, so
      // `lower('РАХУНОК')` returns `'РАХУНОК'` and a SQL-side case-insensitive
      // match misses Cyrillic subjects entirely. Match must use JS Unicode
      // lowercasing so Ukrainian/Russian subjects work.
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'subject', pattern: 'рахунок', ttl_days: 7 });
      expect(
        store.findActiveMatch('any@x.com', 'Ваш РАХУНОК за травень', Date.now()),
      ).not.toBeNull();
      // Mixed-case pattern + lowercase subject — the other direction.
      store.insertRule({ rule_type: 'subject', pattern: 'ЗАКАЗ', ttl_days: 7 });
      expect(
        store.findActiveMatch('any@x.com', 'ваш заказ доставлен', Date.now()),
      ).not.toBeNull();
    });

    it('does not match subject when substring absent', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'subject', pattern: 'invoice', ttl_days: 7 });
      expect(store.findActiveMatch('any@x.com', 'Order shipped today', Date.now())).toBeNull();
    });

    it('treats SQL LIKE wildcards in subject pattern as literal characters', () => {
      // Regression: previously the subject match used LIKE, which would expand
      // user-typed `%` / `_` into wildcards and over-suppress.
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'subject', pattern: '100%', ttl_days: 7 });
      // Literal `100%` substring matches.
      expect(
        store.findActiveMatch('any@x.com', '100% discount today', Date.now()),
      ).not.toBeNull();
      // `%` must NOT act as wildcard — `100 something` does not contain `100%`.
      expect(
        store.findActiveMatch('any@x.com', '100 dollars off', Date.now()),
      ).toBeNull();

      // `_` should not act as a single-char wildcard either.
      store.insertRule({ rule_type: 'subject', pattern: 'order_shipped', ttl_days: 7 });
      expect(
        store.findActiveMatch('any@x.com', 'your order_shipped notification', Date.now()),
      ).not.toBeNull();
      expect(
        store.findActiveMatch('any@x.com', 'your order shipped today', Date.now()),
      ).toBeNull();
    });

    it('skips expired rules (advance fake timer past expires_at)', () => {
      vi.useFakeTimers();
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'sender', pattern: 'spam@x.com', ttl_days: 1 });

      const justBefore = t0 + 86400_000 - 1;
      expect(store.findActiveMatch('spam@x.com', 's', justBefore)).not.toBeNull();

      const justAfter = t0 + 86400_000 + 1;
      expect(store.findActiveMatch('spam@x.com', 's', justAfter)).toBeNull();
    });

    it('keeps forever rules active indefinitely', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'sender', pattern: 'forever@x.com', ttl_days: null });
      const farFuture = Date.now() + 100 * 365 * 86400_000;
      expect(store.findActiveMatch('forever@x.com', 's', farFuture)).not.toBeNull();
    });

    it('matches sender across display-name variance (canonicalizes both sides)', () => {
      // Regression: email_pending.from_addr carries `"Display" <addr>` and the
      // display name often varies across messages from the same sender. The
      // store must key sender rules on the bare address so the rule still
      // matches when the display name changes.
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({
        rule_type: 'sender',
        pattern: '"Bob" <bob@example.com>',
        ttl_days: 7,
      });
      // Same bare address, different display name → must match.
      expect(
        store.findActiveMatch('"Bob Smith" <bob@example.com>', 's', Date.now()),
      ).not.toBeNull();
      // Bare-address inbound → must match.
      expect(
        store.findActiveMatch('bob@example.com', 's', Date.now()),
      ).not.toBeNull();
      // Different bare address → must NOT match.
      expect(
        store.findActiveMatch('"Bob" <bob@other.com>', 's', Date.now()),
      ).toBeNull();
    });

    it('subject rules are stored verbatim (no email parsing applied)', () => {
      // Sender-only canonicalization: subject patterns may contain `<...>` for
      // literal reasons (`<URGENT>` in subject lines, etc.) and must not be
      // transformed.
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({
        rule_type: 'subject',
        pattern: '<URGENT>',
        ttl_days: 7,
      });
      expect(
        store.findActiveMatch('any@x.com', 'Re: <URGENT> action needed', Date.now()),
      ).not.toBeNull();
    });

    it('prefers most recent rule when multiple match', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      const first = store.insertRule({ rule_type: 'sender', pattern: 'a@x.com', ttl_days: 7 });
      const second = store.insertRule({ rule_type: 'sender', pattern: 'a@x.com', ttl_days: 30 });
      const hit = store.findActiveMatch('a@x.com', 's', Date.now());
      expect(hit?.id).toBe(second.id);
      expect(hit?.id).not.toBe(first.id);
    });
  });

  describe('listActive', () => {
    it('excludes expired rules', () => {
      vi.useFakeTimers();
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      const store = createEmailSuppressionStore({ db: getDb() });
      store.insertRule({ rule_type: 'sender', pattern: 'short@x.com', ttl_days: 1 });
      store.insertRule({ rule_type: 'sender', pattern: 'long@x.com', ttl_days: 30 });
      store.insertRule({ rule_type: 'subject', pattern: 'forever-topic', ttl_days: null });

      const later = t0 + 2 * 86400_000;
      const active = store.listActive(later);
      const patterns = active.map((r) => r.pattern).sort();
      expect(patterns).toEqual(['forever-topic', 'long@x.com']);
    });

    it('returns empty array when nothing inserted', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      expect(store.listActive(Date.now())).toEqual([]);
    });
  });

  describe('deleteRule', () => {
    it('returns true on hit, false on miss', () => {
      const store = createEmailSuppressionStore({ db: getDb() });
      const inserted = store.insertRule({
        rule_type: 'sender',
        pattern: 'a@x.com',
        ttl_days: 7,
      });
      expect(store.deleteRule(inserted.id)).toBe(true);
      expect(store.deleteRule(inserted.id)).toBe(false);
      expect(store.deleteRule(9999)).toBe(false);
    });
  });
});
