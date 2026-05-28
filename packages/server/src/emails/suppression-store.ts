import type Database from 'better-sqlite3';

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
      const info = db
        .prepare(
          `INSERT INTO email_suppression_rules
           (rule_type, pattern, created_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(rule_type, pattern, now, expires_at);
      return { id: Number(info.lastInsertRowid), expires_at };
    },
    findActiveMatch(sender, subject, now) {
      const row = db
        .prepare(
          `SELECT * FROM email_suppression_rules
           WHERE (expires_at IS NULL OR expires_at > ?)
             AND (
               (rule_type = 'sender' AND pattern = ?)
               OR (rule_type = 'subject' AND lower(?) LIKE '%' || lower(pattern) || '%')
             )
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(now, sender, subject) as SuppressionRule | undefined;
      return row ?? null;
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
