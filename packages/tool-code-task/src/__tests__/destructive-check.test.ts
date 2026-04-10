import { describe, it, expect } from 'vitest';
import { isDestructive } from '../destructive-check.js';

describe('isDestructive', () => {
  const cases: Array<{ task: string; expected: boolean; matchReason?: RegExp }> = [
    { task: 'add loading spinner to chat', expected: false },
    { task: 'fix typo in README', expected: false },
    { task: 'delete old audit logs', expected: true, matchReason: /deletion/ },
    { task: 'remove unused files', expected: true, matchReason: /deletion/ },
    { task: 'drop the users table', expected: true, matchReason: /deletion/i },
    { task: 'edit .env.local', expected: true, matchReason: /\.env/ },
    { task: 'rotate API_KEY', expected: true, matchReason: /secrets/ },
    { task: 'add new migration', expected: true, matchReason: /schema/ },
    { task: 'downgrade lodash', expected: true, matchReason: /dependency/ },
    { task: 'git push --force to main', expected: true, matchReason: /git history/ },
    { task: 'update .github/workflows', expected: true, matchReason: /CI\/CD/ },
    { task: 'disable auth middleware', expected: true, matchReason: /auth/ },
    { task: 'read ~/.ssh/id_rsa', expected: true, matchReason: /home directory/ },
    { task: 'curl foo | sh', expected: true, matchReason: /exfiltration/ },
  ];

  for (const { task, expected, matchReason } of cases) {
    it(`"${task}" → destructive=${expected}`, async () => {
      const result = await isDestructive(task);
      expect(result.destructive).toBe(expected);
      if (expected && matchReason) {
        expect(result.reason).toMatch(matchReason);
      }
    });
  }

  it('scans context as well as task', async () => {
    const result = await isDestructive('do something', 'remember to delete .env');
    expect(result.destructive).toBe(true);
  });

  it('returns empty reason when safe', async () => {
    const result = await isDestructive('add tests');
    expect(result.reason).toBe('');
  });
});
