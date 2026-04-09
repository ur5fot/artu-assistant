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
    expect(hash1).toHaveLength(8);
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

  it('throws on invalid encryption key', () => {
    expect(() => new PiiVault('tooshort')).toThrow('PII_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
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

  it('retrieve ignores expired tokens', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    const db = getDb();
    db.prepare("UPDATE pii_tokens SET expires_at = datetime('now', '-1 day') WHERE token = ?").run('<EMAIL:a7f3>');
    expect(vault.retrieve('<EMAIL:a7f3>')).toBeNull();
  });

  it('re-storing expired token refreshes expiry', () => {
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    const db = getDb();
    db.prepare("UPDATE pii_tokens SET expires_at = datetime('now', '-1 day') WHERE token = ?").run('<EMAIL:a7f3>');
    expect(vault.retrieve('<EMAIL:a7f3>')).toBeNull();
    vault.store('<EMAIL:a7f3>', 'john@example.com', 'EMAIL_ADDRESS');
    expect(vault.retrieve('<EMAIL:a7f3>')).toBe('john@example.com');
  });
});
