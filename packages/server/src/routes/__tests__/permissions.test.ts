import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createPermissionsRouter } from '../permissions.js';
import { initDb, closeDb, savePermissionRule, getPermissionRule } from '../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DELETE /api/permissions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-perm-test-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears all permission rules', async () => {
    savePermissionRule('file_write', true);
    savePermissionRule('file_delete', false);

    const app = express();
    app.use('/api', createPermissionsRouter());

    await request(app)
      .delete('/api/permissions')
      .expect(200);

    expect(getPermissionRule('file_write')).toBeNull();
    expect(getPermissionRule('file_delete')).toBeNull();
  });
});
