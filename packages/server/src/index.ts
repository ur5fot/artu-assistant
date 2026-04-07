import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createChatRouter } from './routes/chat.js';
import { createClaudeClient } from './ai/claude.js';
import { runToolLoop } from './ai/tool-loop.js';
import { createRegistry } from './tools/registry.js';
import { errorHandler } from './errors.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: `http://localhost:${process.env.CLIENT_PORT || 5173}` }));
app.use(express.json({ limit: '10mb' }));

// Setup
const client = createClaudeClient();
const registry = createRegistry();

import webSearchTool from '@r2/tool-web-search';
registry.register(webSearchTool);

const chatRouter = createChatRouter({
  runLoop: ({ messages, onEvent, signal }) =>
    runToolLoop({ messages, client, registry, onEvent, signal }),
});

app.use('/api', chatRouter);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'R2 online', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`R2 server running on http://localhost:${PORT}`);
});
