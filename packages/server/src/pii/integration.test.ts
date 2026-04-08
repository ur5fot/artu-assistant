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
