import type Database from 'better-sqlite3';
import { parseFromAddress } from './address.js';

export type SuppressionRuleType = 'sender' | 'subject';

export interface SuppressionRule {
  id: number;
  rule_type: SuppressionRuleType;
  pattern: string;
  created_at: number;
  expires_at: number | null;
  created_via: string;
}

export interface InsertedRule {
  id: number;
  expires_at: number | null;
}

export interface InsertRuleInput {
  rule_type: SuppressionRuleType;
  pattern: string;
  ttl_days: number | null;
}

export interface EmailSuppressionStore {
  insertRule(input: InsertRuleInput): InsertedRule;
  findActiveMatch(sender: string, subject: string, now: number): SuppressionRule | null;
  listActive(now: number): SuppressionRule[];
  deleteRule(id: number): boolean;
}

const DAY_MS = 86400_000;

export function createEmailSuppressionStore(deps: {
  db: Database.Database;
}): EmailSuppressionStore {
  const { db } = deps;
  return {
    insertRule({ rule_type, pattern, ttl_days }) {
      const now = Date.now();
      const expires_at = ttl_days === null ? null : now + ttl_days * DAY_MS;
      // Sender rules are keyed by bare address so they survive display-name
      // variance across messages (`"Bob" <b@x>` vs `"Bob Smith" <b@x>`).
      const storedPattern =
        rule_type === 'sender' ? parseFromAddress(pattern) : pattern;
      const info = db
        .prepare(
          `INSERT INTO email_suppression_rules
           (rule_type, pattern, created_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(rule_type, storedPattern, now, expires_at);
      return { id: Number(info.lastInsertRowid), expires_at };
    },
    findActiveMatch(sender, subject, now) {
      // Canonicalize the inbound sender to the bare address so rules inserted
      // before this fix (or via tests passing bare addresses) match either way.
      const senderKey = parseFromAddress(sender);
      // Subject substring is matched JS-side because SQLite's built-in
      // `lower()` is ASCII-only — `lower('РАХУНОК')` returns `'РАХУНОК'`, so a
      // SQL-side `instr(lower(?), lower(pattern))` would miss Cyrillic subjects
      // even though the plan calls for case-insensitive matching. JS's
      // `toLocaleLowerCase` handles Unicode correctly. Sender stays exact-match
      // in SQL because canonicalized addresses are ASCII.
      const lowerSubject = subject.toLocaleLowerCase();
      const candidates = db
        .prepare(
          `SELECT * FROM email_suppression_rules
           WHERE (expires_at IS NULL OR expires_at > ?)
             AND (
               (rule_type = 'sender' AND pattern = ?)
               OR rule_type = 'subject'
             )
           ORDER BY id DESC`,
        )
        .all(now, senderKey) as SuppressionRule[];
      for (const rule of candidates) {
        if (rule.rule_type === 'sender') return rule;
        // Plain `String.prototype.includes` is a literal substring check, so
        // user-typed `%` / `_` in subject patterns stay literal — same property
        // the previous SQL `instr(...)` form had vs. `LIKE`.
        if (lowerSubject.includes(rule.pattern.toLocaleLowerCase())) return rule;
      }
      return null;
    },
    listActive(now) {
      return db
        .prepare(
          `SELECT * FROM email_suppression_rules
           WHERE expires_at IS NULL OR expires_at > ?
           ORDER BY id DESC`,
        )
        .all(now) as SuppressionRule[];
    },
    deleteRule(id) {
      const info = db
        .prepare('DELETE FROM email_suppression_rules WHERE id = ?')
        .run(id);
      return info.changes > 0;
    },
  };
}
