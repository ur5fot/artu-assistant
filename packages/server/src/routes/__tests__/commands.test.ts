import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCommandsRouter } from '../commands.js';

describe('GET /api/commands', () => {
  it('returns commands from registry', async () => {
    const app = express();
    const registry = {
      getCommands: vi.fn().mockReturnValue([
        { name: 'пошук', tool: 'web_search', description: 'Пошук в інтернеті', params: [{ name: 'query', required: true }] },
        { name: 'деплой', tool: 'code_deploy', description: 'Задеплоїти зміни' },
      ]),
    };
    app.use('/api', createCommandsRouter(registry as any));

    const res = await request(app).get('/api/commands').expect(200);

    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('пошук');
    expect(res.body[1].name).toBe('деплой');
  });

  it('returns empty array when no commands registered', async () => {
    const app = express();
    const registry = { getCommands: vi.fn().mockReturnValue([]) };
    app.use('/api', createCommandsRouter(registry as any));

    const res = await request(app).get('/api/commands').expect(200);
    expect(res.body).toEqual([]);
  });
});
