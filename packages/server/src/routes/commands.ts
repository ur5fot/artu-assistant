import { Router } from 'express';
import type { ToolRegistry } from '../tools/registry.js';

export function createCommandsRouter(registry: ToolRegistry): Router {
  const router = Router();

  router.get('/commands', (_req, res) => {
    res.json(registry.getCommands());
  });

  return router;
}
