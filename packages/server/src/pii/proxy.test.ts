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
