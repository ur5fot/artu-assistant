import crypto from 'node:crypto';
import { getDb } from '../db.js';

const ENTITY_TYPE_MAP: Record<string, string> = {
  EMAIL_ADDRESS: 'EMAIL',
  PHONE_NUMBER: 'PHONE',
  CREDIT_CARD: 'CARD',
  IBAN_CODE: 'IBAN',
  IP_ADDRESS: 'IP',
  PERSON: 'PERSON',
  LOCATION: 'LOCATION',
  DATE_TIME: 'DATE',
  US_SSN: 'SSN',
  US_DRIVER_LICENSE: 'LICENSE',
};

export function shortEntityType(presidioType: string): string {
  return ENTITY_TYPE_MAP[presidioType] ?? presidioType.split('_')[0];
}

export class PiiVault {
  private key: Buffer;

  constructor(hexKey: string) {
    this.key = Buffer.from(hexKey, 'hex');
    if (this.key.length !== 32) {
      throw new Error('PII_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    }
  }

  tokenHash(value: string): string {
    return crypto
      .createHmac('sha256', this.key)
      .update(value)
      .digest('hex')
      .slice(0, 8);
  }

  makeToken(value: string, presidioType: string): string {
    const short = shortEntityType(presidioType);
    const hash = this.tokenHash(value);
    return `<${short}:${hash}>`;
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, tag]).toString('base64');
  }

  private decrypt(encoded: string): string {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const encrypted = buf.subarray(12, buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  store(token: string, value: string, entityType: string): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO pii_tokens (token, encrypted_value, entity_type)
       VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET encrypted_value = excluded.encrypted_value, entity_type = excluded.entity_type, expires_at = datetime('now', '+7 days')`
    ).run(token, this.encrypt(value), entityType);
  }

  retrieve(token: string): string | null {
    const db = getDb();
    const row = db.prepare(
      "SELECT encrypted_value FROM pii_tokens WHERE token = ? AND (expires_at IS NULL OR expires_at >= datetime('now'))"
    ).get(token) as { encrypted_value: string } | undefined;
    if (!row) return null;
    return this.decrypt(row.encrypted_value);
  }

  clearAll(): void {
    const db = getDb();
    db.prepare('DELETE FROM pii_tokens').run();
  }

  clearExpired(): void {
    const db = getDb();
    db.prepare("DELETE FROM pii_tokens WHERE expires_at < datetime('now')").run();
  }
}
