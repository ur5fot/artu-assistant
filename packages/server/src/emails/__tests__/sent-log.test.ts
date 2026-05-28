import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createEmailSentLog } from '../sent-log.js';

beforeEach(() => initDb(':memory:'));
afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('createEmailSentLog', () => {
  it('record inserts a row with all fields, created_at set', () => {
    const repo = createEmailSentLog({ db: getDb() });
    const before = Date.now();
    repo.record({
      action: 'sent',
      draftId: 'pending-1',
      to: 'a@b.com',
      subject: 'hi',
    });
    const after = Date.now();

    const row = getDb()
      .prepare('SELECT * FROM email_sent_log WHERE draft_id = ?')
      .get('pending-1') as {
        id: number;
        action: string;
        draft_id: string;
        to_addr: string;
        subject: string;
        error_message: string | null;
        created_at: number;
      };
    expect(row.action).toBe('sent');
    expect(row.draft_id).toBe('pending-1');
    expect(row.to_addr).toBe('a@b.com');
    expect(row.subject).toBe('hi');
    expect(row.error_message).toBeNull();
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
  });

  it('record persists errorMessage for action=error', () => {
    const repo = createEmailSentLog({ db: getDb() });
    repo.record({
      action: 'error',
      draftId: 'pending-2',
      to: 'a@b.com',
      subject: 'hi',
      errorMessage: 'SMTP 550 rejected',
    });
    const row = getDb()
      .prepare('SELECT error_message FROM email_sent_log WHERE draft_id = ?')
      .get('pending-2') as { error_message: string };
    expect(row.error_message).toBe('SMTP 550 rejected');
  });

  it('record rejects invalid action (CHECK constraint throws)', () => {
    const repo = createEmailSentLog({ db: getDb() });
    expect(() =>
      repo.record({
        // @ts-expect-error - intentionally invalid for runtime check
        action: 'bogus',
        draftId: 'p',
        to: 'a@b.com',
        subject: 's',
      }),
    ).toThrow();
  });

  it('countLastDays returns 0 on empty table', () => {
    const repo = createEmailSentLog({ db: getDb() });
    expect(repo.countLastDays('sent', 7)).toBe(0);
    expect(repo.countLastDays('cancelled', 7)).toBe(0);
    expect(repo.countLastDays('error', 7)).toBe(0);
  });

  it('countLastDays(sent, 7) counts only sent rows in last 7 days', () => {
    const repo = createEmailSentLog({ db: getDb() });
    repo.record({ action: 'sent', draftId: 'a', to: 'x@y', subject: 's1' });
    repo.record({ action: 'sent', draftId: 'b', to: 'x@y', subject: 's2' });
    repo.record({ action: 'cancelled', draftId: 'c', to: 'x@y', subject: 's3' });
    repo.record({
      action: 'error',
      draftId: 'd',
      to: 'x@y',
      subject: 's4',
      errorMessage: 'oops',
    });

    expect(repo.countLastDays('sent', 7)).toBe(2);
    expect(repo.countLastDays('cancelled', 7)).toBe(1);
    expect(repo.countLastDays('error', 7)).toBe(1);
  });

  it('countLastDays does not double-count old rows', () => {
    // Insert a row dated 10 days ago by writing directly with a frozen
    // created_at, then a row from now via repo.record(). countLastDays(7)
    // must return 1, not 2.
    const db = getDb();
    const tenDaysAgo = Date.now() - 10 * 86400_000;
    db.prepare(
      `INSERT INTO email_sent_log
       (action, draft_id, to_addr, subject, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sent', 'old', 'x@y', 's-old', null, tenDaysAgo);

    const repo = createEmailSentLog({ db });
    repo.record({ action: 'sent', draftId: 'new', to: 'x@y', subject: 's-new' });

    expect(repo.countLastDays('sent', 7)).toBe(1);
    expect(repo.countLastDays('sent', 30)).toBe(2);
  });
});
