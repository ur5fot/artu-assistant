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
    // Mock analyzer response — only analyzer is called now (local replacement)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { entity_type: 'EMAIL_ADDRESS', start: 10, end: 26, score: 0.95 },
        { entity_type: 'PHONE_NUMBER', start: 39, end: 52, score: 0.90 },
      ],
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

    // Verify deanonymize restores originals
    const restored = await proxy.deanonymize(anon.text);
    expect(restored).toContain('john@example.com');
    expect(restored).toContain('+380501234567');
  });

  it('audit log contains placeholders, not real PII', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
      ],
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
    expect(result.text).toMatch(/<EMAIL:[a-f0-9]{8}>/);
  });

  it('consistent hashing: same PII always maps to same token', async () => {
    // Two separate analyze calls for same email — only analyzer is called
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        ],
      });

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    // Both calls use the same email → same token should be generated
    const result1 = await proxy.anonymize('john@example.com');
    const result2 = await proxy.anonymize('john@example.com');
    expect(result1.text).toBe(result2.text);
    expect(result1.entities[0].token).toBe(result2.entities[0].token);
  });

  it('handles multiple entities of the same type correctly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { entity_type: 'EMAIL_ADDRESS', start: 0, end: 16, score: 0.95 },
        { entity_type: 'EMAIL_ADDRESS', start: 21, end: 37, score: 0.95 },
      ],
    });

    const proxy = createPiiProxy({
      encryptionKey: testKey,
      analyzerUrl: 'http://localhost:5002',
      anonymizerUrl: 'http://localhost:5001',
      entityTypes: ['EMAIL_ADDRESS'],
      mode: 'required',
    });

    const anon = await proxy.anonymize('john@example.com and jane@example.com');
    expect(anon.entities).toHaveLength(2);
    expect(anon.text).not.toContain('john@example.com');
    expect(anon.text).not.toContain('jane@example.com');

    // Each email should get a unique token
    const tokens = anon.entities.map(e => e.token);
    expect(tokens[0]).not.toBe(tokens[1]);

    // Deanonymize should restore both
    const restored = await proxy.deanonymize(anon.text);
    expect(restored).toContain('john@example.com');
    expect(restored).toContain('jane@example.com');
  });
});
