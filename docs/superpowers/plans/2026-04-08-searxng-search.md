# SearXNG: Замена Brave Search — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** Заменить Brave Search API на self-hosted SearXNG в Docker. Localhost-first поиск без внешних API ключей.

**Архитектура:** docker-compose поднимает SearXNG на порту 8888. `tool-web-search` делает GET запрос к `SEARXNG_URL/search?q=...&format=json`. Никаких API ключей.

**Стек:** Docker, SearXNG, Node.js fetch

**Спек:** `docs/superpowers/specs/2026-04-08-searxng-search-design.md`

---

## Карта файлов

```
r2/
├── docker-compose.yml                                    # НОВЫЙ: SearXNG сервис
├── searxng/
│   ├── settings.yml                                      # НОВЫЙ: настройки SearXNG
│   └── limiter.toml                                      # НОВЫЙ: отключить rate limiter
├── .env.example                                          # Обновить: Brave → SearXNG
├── AGENTS.md                                             # Обновить: стек
├── packages/tool-web-search/
│   ├── src/index.ts                                      # Обновить: Brave → SearXNG
│   └── __tests__/web-search.test.ts                      # Обновить: тесты
└── packages/server/src/routes/__tests__/chat.test.ts     # Обновить: sanitize если есть Brave refs
```

---

## Задача 1: Docker Compose + SearXNG конфиг

**Файлы:**
- Создать: `docker-compose.yml`
- Создать: `searxng/settings.yml`
- Создать: `searxng/limiter.toml`

- [x] **Шаг 1: Создать docker-compose.yml**

Создать `docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng
    container_name: r2-searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    restart: unless-stopped
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888
```

- [x] **Шаг 2: Создать searxng/settings.yml**

Создать `searxng/settings.yml`:

```yaml
use_default_settings: true

server:
  secret_key: "r2-searxng-local-dev-key-change-in-prod"
  bind_address: "0.0.0.0"
  port: 8080

search:
  formats:
    - html
    - json
  default_lang: ""
  autocomplete: ""
```

- [x] **Шаг 3: Создать searxng/limiter.toml**

Создать `searxng/limiter.toml`:

```toml
[botdetection.ip_limit]
# Отключить rate limiting для localhost
link_token = false

[botdetection.ip_lists]
pass_ip = ["127.0.0.0/8", "192.168.0.0/16", "172.16.0.0/12", "10.0.0.0/8"]
```

- [x] **Шаг 4: Добавить searxng/ в .gitignore исключения**

В `.gitignore` добавить комментарий что `searxng/` НЕ игнорируется (это конфиг, не данные). Убедиться что директория `searxng/` трекается git.

- [x] **Шаг 5: Коммит**

```bash
git add docker-compose.yml searxng/
git commit -m "feat: add SearXNG Docker setup for self-hosted search"
```

---

## Задача 2: Обновить web_search tool

**Файлы:**
- Изменить: `packages/tool-web-search/src/index.ts`

- [x] **Шаг 1: Заменить реализацию web_search**

Заменить содержимое `packages/tool-web-search/src/index.ts`:

```typescript
import type { ToolResult } from '@r2/shared';

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface SearXNGResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using SearXNG. Use when you need current information, facts, or answers not in your training data.',
  permissionLevel: 'auto' as const,
  parameters: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (default 5, max 20)',
      },
    },
    required: ['query'] as string[],
  },

  async handler(params: Record<string, unknown>): Promise<ToolResult> {
    const query = params.query as string;
    const rawCount = Number(params.count);
    const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 5, 1), 20);

    const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8888';
    const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return {
        success: false,
        error: `Web search failed: ${err instanceof Error ? err.message : 'Network error'}`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Search error: ${response.status} ${response.statusText}`,
      };
    }

    let data: SearXNGResponse;
    try {
      data = await response.json();
    } catch {
      return { success: false, error: 'Search returned invalid JSON' };
    }

    const results: SearchResult[] = (data.results ?? [])
      .slice(0, count)
      .map((r) => ({
        title: r.title,
        url: r.url,
        description: r.content,
      }));

    return {
      success: true,
      data: results,
      display: {
        type: 'text',
        content: results.map((r) => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'),
      },
    };
  },
};

export default webSearchTool;
```

- [x] **Шаг 2: Коммит**

```bash
git add packages/tool-web-search/src/index.ts
git commit -m "feat: replace Brave Search with SearXNG in web_search tool"
```

---

## Задача 3: Обновить тесты

**Файлы:**
- Изменить: `packages/tool-web-search/__tests__/web-search.test.ts`

- [x] **Шаг 1: Заменить тесты**

Заменить содержимое `packages/tool-web-search/__tests__/web-search.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webSearchTool } from '../src/index.js';

const MOCK_SEARXNG_RESPONSE = {
  results: [
    {
      title: 'Example Result',
      url: 'https://example.com',
      content: 'An example search result.',
    },
    {
      title: 'Another Result',
      url: 'https://another.com',
      content: 'Another search result.',
    },
  ],
};

describe('web_search tool', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.SEARXNG_URL;

  beforeEach(() => {
    process.env.SEARXNG_URL = 'http://localhost:8888';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.SEARXNG_URL = originalEnv;
    } else {
      delete process.env.SEARXNG_URL;
    }
  });

  it('has correct metadata', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.permissionLevel).toBe('auto');
    expect(webSearchTool.parameters.required).toContain('query');
  });

  it('returns formatted search results on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SEARXNG_RESPONSE,
    });

    const result = await webSearchTool.handler({ query: 'test query', count: 5 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect((result.data as any[])[0]).toEqual({
      title: 'Example Result',
      url: 'https://example.com',
      description: 'An example search result.',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('q=test%20query'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('uses SEARXNG_URL from env', async () => {
    process.env.SEARXNG_URL = 'http://custom:9999';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await webSearchTool.handler({ query: 'test' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://custom:9999/search'),
      expect.anything(),
    );
  });

  it('defaults to localhost:8888 when SEARXNG_URL not set', async () => {
    delete process.env.SEARXNG_URL;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await webSearchTool.handler({ query: 'test' });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:8888/search'),
      expect.anything(),
    );
  });

  it('returns error on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('503');
  });

  it('returns error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Connection refused');
  });

  it('returns error on invalid JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new Error('invalid'); },
    });

    const result = await webSearchTool.handler({ query: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid JSON');
  });

  it('respects count parameter', async () => {
    const manyResults = {
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        content: `Content ${i}`,
      })),
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => manyResults,
    });

    const result = await webSearchTool.handler({ query: 'test', count: 3 });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });
});
```

- [x] **Шаг 2: Запустить тесты**

```bash
npx vitest run packages/tool-web-search/__tests__/web-search.test.ts
```

Ожидание: 8 тестов PASS.

- [x] **Шаг 3: Коммит**

```bash
git add packages/tool-web-search/__tests__/web-search.test.ts
git commit -m "test: update web_search tests for SearXNG"
```

---

## Задача 4: Обновить конфигурацию и документацию

**Файлы:**
- Изменить: `.env.example`
- Изменить: `AGENTS.md`
- Изменить: `packages/server/src/routes/__tests__/chat.test.ts` (если есть Brave references в sanitize)

- [x] **Шаг 1: Обновить .env.example**

Заменить содержимое `.env.example`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
CLIENT_PORT=5173
# SearXNG URL (default: http://localhost:8888)
SEARXNG_URL=http://localhost:8888
# SQLite database path (default: ./data/r2.db)
DB_PATH=./data/r2.db
# Root directory for file operations (default: ~/Documents/r2)
R2_FILES_ROOT=~/Documents/r2
```

- [x] **Шаг 2: Обновить AGENTS.md — заменить Brave на SearXNG в стеке**

В секции `## Стек` заменить строку:
```
- **Search:** Brave Search API (MVP), позже — опционально SearXNG
```
На:
```
- **Search:** SearXNG (self-hosted, Docker)
```

В секции `## Env Variables` заменить `BRAVE_SEARCH_API_KEY=...` на:
```
SEARXNG_URL=http://localhost:8888
```

- [x] **Шаг 3: Обновить error sanitization в chat.test.ts**

Проверить `packages/server/src/routes/__tests__/chat.test.ts` — если есть тесты для sanitize "brave" ошибок, обновить на "searxng" или "search". Если sanitize проверяет общий паттерн "search" — оставить как есть.

- [x] **Шаг 4: Обновить error sanitization в chat.ts**

Проверить `packages/server/src/routes/chat.ts` — если `sanitizeError()` фильтрует "brave", заменить на "searxng" или убрать специфичный фильтр (SearXNG localhost, нет ключей для утечки).

- [x] **Шаг 5: Запустить все тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [x] **Шаг 6: Typecheck**

```bash
npx tsc --noEmit -p packages/tool-web-search/tsconfig.json && \
npx tsc --noEmit -p packages/server/tsconfig.json
```

Ожидание: нет ошибок.

- [x] **Шаг 7: Коммит**

```bash
git add .env.example AGENTS.md packages/server/src/routes/
git commit -m "feat: complete SearXNG migration — update config, docs, and error handling"
```

---

## Задача 5: Обновить запуск в AGENTS.md

**Файлы:**
- Изменить: `AGENTS.md`

- [x] **Шаг 1: Обновить секцию запуска**

В секции `### Запуск` (Phase 1) заменить:
```bash
# Из корня — запускает server + client одновременно
npm run dev
```
На:
```bash
# 1. Поднять SearXNG
docker compose up -d

# 2. Запустить server + client
npm run dev
```

- [x] **Шаг 2: Коммит**

```bash
git add AGENTS.md
git commit -m "docs: update launch instructions with Docker Compose"
```
