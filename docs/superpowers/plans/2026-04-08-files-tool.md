# Phase 2B: Files Tool — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** Добавить пакет `@r2/tool-files` с 5 файловыми операциями (read, write, list, delete, move), permission level enforcement в tool loop, и поддержку массивов tools в auto-discovery.

**Архитектура:** Новый пакет `packages/tool-files/` экспортирует массив из 5 `ToolDefinition`. Auto-discovery обновляется для поддержки массивов. Tool loop проверяет `permissionLevel` перед выполнением. Все операции ограничены configurable root directory (`R2_FILES_ROOT`).

**Стек:** Node.js fs/path/os, Vitest

**Спек:** `docs/superpowers/specs/2026-04-08-files-tool-design.md`

---

## Карта файлов

```
packages/
├── server/src/
│   ├── tools/
│   │   ├── base.ts                           # Добавить permissionLevel в ToolDefinition
│   │   ├── registry.ts                       # Поддержка массивов в discoverTools
│   │   └── __tests__/registry.test.ts        # Тест массивов
│   └── ai/
│       ├── tool-loop.ts                      # Permission enforcement
│       └── __tests__/tool-loop.test.ts       # Тест permission блокировки
├── tool-web-search/src/index.ts              # Добавить permissionLevel: 'auto'
└── tool-files/                               # НОВЫЙ ПАКЕТ
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── index.ts                          # Экспорт массива ToolDefinition[]
    │   ├── paths.ts                          # resolveRoot, safePath
    │   └── operations.ts                     # 5 файловых операций
    └── __tests__/
        ├── paths.test.ts                     # Тесты path validation
        └── operations.test.ts                # Тесты операций
```

---

## Задача 1: Добавить permissionLevel в ToolDefinition

**Файлы:**
- Изменить: `packages/server/src/tools/base.ts`
- Изменить: `packages/tool-web-search/src/index.ts`
- Изменить: `packages/server/src/tools/__tests__/registry.test.ts`
- Изменить: `packages/server/src/ai/__tests__/tool-loop.test.ts`

- [x] **Шаг 1: Обновить ToolDefinition в base.ts**

Изменить `packages/server/src/tools/base.ts` — добавить поле `permissionLevel`:

```typescript
import type { ToolResult } from '@r2/shared';

export interface ToolDefinition {
  name: string;
  description: string;
  permissionLevel: 'auto' | 'confirm' | 'forbidden';
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<ToolResult>;
}

export function toClaudeTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}
```

- [x] **Шаг 2: Добавить permissionLevel в web-search tool**

Изменить `packages/tool-web-search/src/index.ts` — добавить поле после `description`:

```typescript
export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web using Brave Search API. Use when you need current information, facts, or answers not in your training data.',
  permissionLevel: 'auto' as const,
  // ... остальное без изменений
```

- [x] **Шаг 3: Обновить mockTool в тесте registry**

Изменить `packages/server/src/tools/__tests__/registry.test.ts` — добавить `permissionLevel` в `mockTool`:

```typescript
const mockTool: ToolDefinition = {
  name: 'test_tool',
  description: 'A test tool',
  permissionLevel: 'auto',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  handler: async () => ({ success: true, data: 'ok' }),
};
```

- [x] **Шаг 4: Обновить mockRegistry в тестах tool-loop**

Изменить `packages/server/src/ai/__tests__/tool-loop.test.ts` — в функции `mockRegistry` добавить `permissionLevel`:

```typescript
function mockRegistry(tools: Record<string, (params: any) => any> = {}): ToolRegistry {
  const toolDefs = Object.entries(tools).map(([name, handler]) => ({
    name,
    description: `Mock ${name}`,
    permissionLevel: 'auto' as const,
    parameters: { type: 'object' as const, properties: {}, required: [] },
    handler: async (params: Record<string, unknown>) => handler(params),
  }));

  return {
    register: vi.fn(),
    get: (name: string) => toolDefs.find((t) => t.name === name),
    getAll: () => toolDefs,
  };
}
```

- [x] **Шаг 5: Запустить тесты**

```bash
npm test
```

Ожидание: все существующие тесты проходят.

- [x] **Шаг 6: Коммит**

```bash
git add packages/server/src/tools/base.ts packages/tool-web-search/src/index.ts packages/server/src/tools/__tests__/registry.test.ts packages/server/src/ai/__tests__/tool-loop.test.ts
git commit -m "feat: add permissionLevel to ToolDefinition"
```

---

## Задача 2: Permission enforcement в tool loop

**Файлы:**
- Изменить: `packages/server/src/ai/tool-loop.ts`
- Изменить: `packages/server/src/ai/__tests__/tool-loop.test.ts`

- [ ] **Шаг 1: Написать failing тест для permission блокировки**

Добавить в `packages/server/src/ai/__tests__/tool-loop.test.ts` внутри describe `'Agentic Tool Loop'`, после последнего теста:

```typescript
  it('blocks tool with confirm permission level', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_c', name: 'write_file', input: { path: 'test.txt' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Cannot write without permission.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'write_file',
      description: 'Write a file',
      permissionLevel: 'confirm' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'written' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Write file' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    // Handler should NOT have been called
    expect(toolDefs[0].handler).not.toHaveBeenCalled();

    // Should have returned error result
    const resultEvent = events.find((e) => e.type === 'tool_call_result');
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === 'tool_call_result') {
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('requires user confirmation');
    }
  });

  it('blocks tool with forbidden permission level', async () => {
    const client = mockClaudeClient([
      {
        content: [
          { type: 'tool_use', id: 'call_f', name: 'dangerous', input: {} },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'Forbidden.' }],
        stop_reason: 'end_turn',
      },
    ]);

    const toolDefs = [{
      name: 'dangerous',
      description: 'Dangerous tool',
      permissionLevel: 'forbidden' as const,
      parameters: { type: 'object' as const, properties: {}, required: [] },
      handler: vi.fn(async () => ({ success: true, data: 'done' })),
    }];

    const registry: ToolRegistry = {
      register: vi.fn(),
      get: (name: string) => toolDefs.find((t) => t.name === name),
      getAll: () => toolDefs,
    };

    const events: SSEEvent[] = [];

    await runToolLoop({
      messages: [{ role: 'user', content: 'Do dangerous thing' }],
      client,
      registry,
      onEvent: (e) => events.push(e),
    });

    expect(toolDefs[0].handler).not.toHaveBeenCalled();
    const resultEvent = events.find((e) => e.type === 'tool_call_result');
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === 'tool_call_result') {
      expect(resultEvent.result.success).toBe(false);
      expect(resultEvent.result.error).toContain('forbidden');
    }
  });
```

- [ ] **Шаг 2: Запустить тест — убедиться что падает**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Ожидание: FAIL — handler вызывается для confirm/forbidden (нет проверки permission).

- [ ] **Шаг 3: Добавить permission enforcement в tool-loop.ts**

Изменить `packages/server/src/ai/tool-loop.ts`. Заменить блок выполнения tool (строки 83-95):

Было:
```typescript
      const startTime = Date.now();
      if (toolDef) {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      } else {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      }
```

Стало:
```typescript
      const startTime = Date.now();
      if (!toolDef) {
        result = { success: false, error: `Unknown tool: ${block.name}` };
      } else if (toolDef.permissionLevel === 'forbidden') {
        result = { success: false, error: `This action is forbidden` };
      } else if (toolDef.permissionLevel === 'confirm') {
        result = { success: false, error: `This action requires user confirmation (not yet implemented)` };
      } else {
        try {
          result = await toolDef.handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
```

- [ ] **Шаг 4: Запустить тесты**

```bash
npx vitest run packages/server/src/ai/__tests__/tool-loop.test.ts
```

Ожидание: все тесты PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add packages/server/src/ai/tool-loop.ts packages/server/src/ai/__tests__/tool-loop.test.ts
git commit -m "feat: add permission level enforcement in tool loop"
```

---

## Задача 3: Поддержка массивов в auto-discovery

**Файлы:**
- Изменить: `packages/server/src/tools/registry.ts`
- Изменить: `packages/server/src/tools/__tests__/registry.test.ts`

- [ ] **Шаг 1: Написать failing тест**

Добавить в `packages/server/src/tools/__tests__/registry.test.ts` в describe `'discoverTools'`:

```typescript
  it('registers tools from array exports', async () => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', 'r2-array-test-'));
    const toolDir = path.join(tmpDir, 'tool-multi');
    fs.mkdirSync(toolDir);
    fs.writeFileSync(path.join(toolDir, 'package.json'), JSON.stringify({
      name: '@r2/tool-multi',
      main: 'index.js',
    }));
    fs.writeFileSync(path.join(toolDir, 'index.js'), `
      module.exports.default = [
        {
          name: 'tool_a',
          description: 'Tool A',
          permissionLevel: 'auto',
          parameters: { type: 'object', properties: {}, required: [] },
          handler: async () => ({ success: true }),
        },
        {
          name: 'tool_b',
          description: 'Tool B',
          permissionLevel: 'confirm',
          parameters: { type: 'object', properties: {}, required: [] },
          handler: async () => ({ success: true }),
        },
      ];
    `);

    const registry = await discoverTools(tmpDir);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get('tool_a')).toBeDefined();
    expect(registry.get('tool_b')).toBeDefined();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
```

- [ ] **Шаг 2: Запустить тест — убедиться что падает**

```bash
npx vitest run packages/server/src/tools/__tests__/registry.test.ts
```

Ожидание: FAIL — массив не распознаётся, регистрируется 0 tools.

- [ ] **Шаг 3: Обновить discoverTools для поддержки массивов**

Изменить `packages/server/src/tools/registry.ts`. Заменить блок внутри `for (const entry of entries)`:

Было:
```typescript
      const mod = await import(toolPackageName);
      const tool: ToolDefinition = mod.default;
      if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
        registry.register(tool);
        console.log(`  Tool discovered: ${tool.name} (${entry})`);
      }
```

Стало:
```typescript
      const mod = await import(toolPackageName);
      const exported = mod.default;

      const toRegister: ToolDefinition[] = Array.isArray(exported) ? exported : [exported];

      for (const tool of toRegister) {
        if (tool && typeof tool.name === 'string' && typeof tool.handler === 'function') {
          registry.register(tool);
          console.log(`  Tool discovered: ${tool.name} (${entry})`);
        }
      }
```

- [ ] **Шаг 4: Запустить тесты**

```bash
npx vitest run packages/server/src/tools/__tests__/registry.test.ts
```

Ожидание: все тесты PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add packages/server/src/tools/registry.ts packages/server/src/tools/__tests__/registry.test.ts
git commit -m "feat: support array tool exports in auto-discovery"
```

---

## Задача 4: Модуль paths — валидация путей

**Файлы:**
- Создать: `packages/tool-files/package.json`
- Создать: `packages/tool-files/tsconfig.json`
- Создать: `packages/tool-files/src/paths.ts`
- Тест: `packages/tool-files/__tests__/paths.test.ts`

- [ ] **Шаг 1: Создать package.json**

Создать `packages/tool-files/package.json`:

```json
{
  "name": "@r2/tool-files",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@r2/shared": "*"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Шаг 2: Создать tsconfig.json**

Создать `packages/tool-files/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Шаг 3: Написать failing тесты для paths**

Создать `packages/tool-files/__tests__/paths.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRoot, safePath } from '../src/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('resolveRoot', () => {
  const originalEnv = process.env.R2_FILES_ROOT;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.R2_FILES_ROOT = originalEnv;
    } else {
      delete process.env.R2_FILES_ROOT;
    }
  });

  it('returns R2_FILES_ROOT when set', () => {
    process.env.R2_FILES_ROOT = '/tmp/r2-custom';
    expect(resolveRoot()).toBe('/tmp/r2-custom');
  });

  it('defaults to ~/Documents/r2', () => {
    delete process.env.R2_FILES_ROOT;
    expect(resolveRoot()).toBe(path.join(os.homedir(), 'Documents', 'r2'));
  });
});

describe('safePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves relative paths within root', () => {
    const result = safePath(tmpRoot, 'subdir/file.txt');
    expect(result).toBe(path.join(tmpRoot, 'subdir', 'file.txt'));
  });

  it('resolves "." to root itself', () => {
    const result = safePath(tmpRoot, '.');
    expect(result).toBe(tmpRoot);
  });

  it('rejects paths that traverse outside root', () => {
    expect(() => safePath(tmpRoot, '../../../etc/passwd')).toThrow('Path outside allowed directory');
  });

  it('rejects absolute paths outside root', () => {
    expect(() => safePath(tmpRoot, '/etc/passwd')).toThrow('Path outside allowed directory');
  });

  it('allows absolute paths inside root', () => {
    const fullPath = path.join(tmpRoot, 'inside.txt');
    const result = safePath(tmpRoot, fullPath);
    expect(result).toBe(fullPath);
  });
});
```

- [ ] **Шаг 4: Запустить тесты — убедиться что падает**

```bash
npx vitest run packages/tool-files/__tests__/paths.test.ts
```

Ожидание: FAIL — `paths.ts` не существует.

- [ ] **Шаг 5: Реализовать paths.ts**

Создать `packages/tool-files/src/paths.ts`:

```typescript
import path from 'node:path';
import os from 'node:os';

export function resolveRoot(): string {
  return process.env.R2_FILES_ROOT || path.join(os.homedir(), 'Documents', 'r2');
}

export function safePath(root: string, userPath: string): string {
  const resolved = path.resolve(root, userPath);
  const normalizedRoot = path.resolve(root);

  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error('Path outside allowed directory');
  }

  return resolved;
}
```

- [ ] **Шаг 6: Запустить тесты**

```bash
npx vitest run packages/tool-files/__tests__/paths.test.ts
```

Ожидание: 7 тестов PASS.

- [ ] **Шаг 7: Коммит**

```bash
git add packages/tool-files/
git commit -m "feat: add tool-files package with path validation"
```

---

## Задача 5: Файловые операции

**Файлы:**
- Создать: `packages/tool-files/src/operations.ts`
- Тест: `packages/tool-files/__tests__/operations.test.ts`

- [ ] **Шаг 1: Написать failing тесты**

Создать `packages/tool-files/__tests__/operations.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, listFiles, deleteFile, moveFile } from '../src/operations.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('File Operations', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-ops-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('reads text file content', async () => {
      fs.writeFileSync(path.join(root, 'hello.txt'), 'Hello World');
      const result = await readFile(root, 'hello.txt');
      expect(result.success).toBe(true);
      expect(result.data).toBe('Hello World');
    });

    it('returns error for non-existent file', async () => {
      const result = await readFile(root, 'missing.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error for file > 1MB', async () => {
      const largeBuf = Buffer.alloc(1024 * 1024 + 1, 'a');
      fs.writeFileSync(path.join(root, 'large.txt'), largeBuf);
      const result = await readFile(root, 'large.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('1MB');
    });

    it('returns error for binary file', async () => {
      const buf = Buffer.alloc(512);
      buf[0] = 0x00; // null byte
      fs.writeFileSync(path.join(root, 'binary.bin'), buf);
      const result = await readFile(root, 'binary.bin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('binary');
    });

    it('rejects paths outside root', async () => {
      const result = await readFile(root, '../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('writeFile', () => {
    it('creates new file with content', async () => {
      const result = await writeFile(root, 'new.txt', 'content');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf-8')).toBe('content');
    });

    it('creates intermediate directories', async () => {
      const result = await writeFile(root, 'deep/nested/file.txt', 'data');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('data');
    });

    it('overwrites existing file', async () => {
      fs.writeFileSync(path.join(root, 'exist.txt'), 'old');
      const result = await writeFile(root, 'exist.txt', 'new');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'exist.txt'), 'utf-8')).toBe('new');
    });

    it('rejects paths outside root', async () => {
      const result = await writeFile(root, '../../evil.txt', 'hack');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('listFiles', () => {
    it('lists directory contents', async () => {
      fs.writeFileSync(path.join(root, 'a.txt'), 'a');
      fs.writeFileSync(path.join(root, 'b.txt'), 'b');
      fs.mkdirSync(path.join(root, 'subdir'));

      const result = await listFiles(root, '.', false);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries).toHaveLength(3);
      expect(entries.some((e) => e.name === 'a.txt' && e.type === 'file')).toBe(true);
      expect(entries.some((e) => e.name === 'subdir' && e.type === 'directory')).toBe(true);
    });

    it('returns error for non-existent directory', async () => {
      const result = await listFiles(root, 'nope', false);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('lists recursively with recursive: true', async () => {
      fs.mkdirSync(path.join(root, 'sub'));
      fs.writeFileSync(path.join(root, 'top.txt'), 'top');
      fs.writeFileSync(path.join(root, 'sub', 'deep.txt'), 'deep');

      const result = await listFiles(root, '.', true);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries.some((e) => e.name === 'sub/deep.txt')).toBe(true);
    });

    it('truncates at 1000 entries', async () => {
      for (let i = 0; i < 1005; i++) {
        fs.writeFileSync(path.join(root, `file_${String(i).padStart(4, '0')}.txt`), '');
      }

      const result = await listFiles(root, '.', false);
      expect(result.success).toBe(true);
      const entries = result.data as Array<{ name: string; type: string }>;
      expect(entries).toHaveLength(1000);
      expect(result.display?.content).toContain('truncated');
    });
  });

  describe('deleteFile', () => {
    it('removes a file', async () => {
      fs.writeFileSync(path.join(root, 'del.txt'), 'bye');
      const result = await deleteFile(root, 'del.txt');
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, 'del.txt'))).toBe(false);
    });

    it('returns error for non-existent file', async () => {
      const result = await deleteFile(root, 'ghost.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects paths outside root', async () => {
      const result = await deleteFile(root, '../../important.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });

  describe('moveFile', () => {
    it('moves file to new location', async () => {
      fs.writeFileSync(path.join(root, 'src.txt'), 'data');
      const result = await moveFile(root, 'src.txt', 'dst.txt');
      expect(result.success).toBe(true);
      expect(fs.existsSync(path.join(root, 'src.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'dst.txt'), 'utf-8')).toBe('data');
    });

    it('creates intermediate directories for destination', async () => {
      fs.writeFileSync(path.join(root, 'move-me.txt'), 'data');
      const result = await moveFile(root, 'move-me.txt', 'newdir/moved.txt');
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(root, 'newdir', 'moved.txt'), 'utf-8')).toBe('data');
    });

    it('returns error when source does not exist', async () => {
      const result = await moveFile(root, 'nope.txt', 'dst.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('rejects source paths outside root', async () => {
      const result = await moveFile(root, '../../etc/passwd', 'stolen.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });

    it('rejects destination paths outside root', async () => {
      fs.writeFileSync(path.join(root, 'legit.txt'), 'data');
      const result = await moveFile(root, 'legit.txt', '../../escaped.txt');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });
  });
});
```

- [ ] **Шаг 2: Запустить тесты — убедиться что падает**

```bash
npx vitest run packages/tool-files/__tests__/operations.test.ts
```

Ожидание: FAIL — `operations.ts` не существует.

- [ ] **Шаг 3: Реализовать operations.ts**

Создать `packages/tool-files/src/operations.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { ToolResult } from '@r2/shared';
import { safePath } from './paths.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_LIST_ENTRIES = 1000;

export async function readFile(root: string, filePath: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    return { success: false, error: `File exceeds 1MB limit (${stat.size} bytes)` };
  }

  // Check for binary content
  const fd = fs.openSync(resolved, 'r');
  const checkBuf = Buffer.alloc(Math.min(512, stat.size));
  fs.readSync(fd, checkBuf, 0, checkBuf.length, 0);
  fs.closeSync(fd);

  if (checkBuf.includes(0x00)) {
    return { success: false, error: 'Cannot read binary file' };
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  return {
    success: true,
    data: content,
    display: { type: 'code', content },
  };
}

export async function writeFile(root: string, filePath: string, content: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolved, content, 'utf-8');
  return {
    success: true,
    data: { path: filePath, bytes: Buffer.byteLength(content) },
    display: { type: 'text', content: `Written ${filePath} (${Buffer.byteLength(content)} bytes)` },
  };
}

function collectEntries(
  root: string,
  dir: string,
  prefix: string,
  recursive: boolean,
  entries: Array<{ name: string; type: string }>,
): void {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    const type = item.isDirectory() ? 'directory' : 'file';
    entries.push({ name, type });
    if (recursive && item.isDirectory()) {
      collectEntries(root, path.join(dir, item.name), name, true, entries);
    }
  }
}

export async function listFiles(root: string, dirPath: string, recursive: boolean): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, dirPath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { success: false, error: `Directory not found: ${dirPath}` };
  }

  const entries: Array<{ name: string; type: string }> = [];
  collectEntries(root, resolved, '', recursive, entries);

  // Count total if we hit the limit
  let totalCount = entries.length;
  if (entries.length >= MAX_LIST_ENTRIES) {
    // Re-count total for truncation message
    const countAll = (d: string): number => {
      let count = 0;
      const items = fs.readdirSync(d, { withFileTypes: true });
      for (const item of items) {
        count++;
        if (recursive && item.isDirectory()) {
          count += countAll(path.join(d, item.name));
        }
      }
      return count;
    };
    totalCount = countAll(resolved);
  }

  const truncated = totalCount > MAX_LIST_ENTRIES;
  const displayLines = entries.map((e) => `${e.type === 'directory' ? '[dir]' : '     '} ${e.name}`);
  const displayContent = truncated
    ? displayLines.join('\n') + `\n\n(truncated, ${MAX_LIST_ENTRIES} of ${totalCount} total)`
    : displayLines.join('\n');

  return {
    success: true,
    data: entries,
    display: { type: 'text', content: displayContent },
  };
}

export async function deleteFile(root: string, filePath: string): Promise<ToolResult> {
  let resolved: string;
  try {
    resolved = safePath(root, filePath);
  } catch {
    return { success: false, error: 'Path outside allowed directory' };
  }

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${filePath}` };
  }

  fs.unlinkSync(resolved);
  return {
    success: true,
    data: { path: filePath },
    display: { type: 'text', content: `Deleted ${filePath}` },
  };
}

export async function moveFile(root: string, source: string, destination: string): Promise<ToolResult> {
  let resolvedSrc: string;
  let resolvedDst: string;
  try {
    resolvedSrc = safePath(root, source);
  } catch {
    return { success: false, error: 'Source path outside allowed directory' };
  }
  try {
    resolvedDst = safePath(root, destination);
  } catch {
    return { success: false, error: 'Destination path outside allowed directory' };
  }

  if (!fs.existsSync(resolvedSrc)) {
    return { success: false, error: `Source not found: ${source}` };
  }

  const dstDir = path.dirname(resolvedDst);
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  fs.renameSync(resolvedSrc, resolvedDst);
  return {
    success: true,
    data: { source, destination },
    display: { type: 'text', content: `Moved ${source} → ${destination}` },
  };
}
```

- [ ] **Шаг 4: Запустить тесты**

```bash
npx vitest run packages/tool-files/__tests__/operations.test.ts
```

Ожидание: 17 тестов PASS.

- [ ] **Шаг 5: Коммит**

```bash
git add packages/tool-files/src/operations.ts packages/tool-files/__tests__/operations.test.ts
git commit -m "feat: implement 5 file operations with security checks"
```

---

## Задача 6: Index — экспорт массива ToolDefinition[]

**Файлы:**
- Создать: `packages/tool-files/src/index.ts`

- [ ] **Шаг 1: Создать index.ts**

Создать `packages/tool-files/src/index.ts`:

```typescript
import type { ToolResult } from '@r2/shared';
import { resolveRoot } from './paths.js';
import { readFile, writeFile, listFiles, deleteFile, moveFile } from './operations.js';

const tools = [
  {
    name: 'file_read',
    description: 'Read the contents of a text file. Returns the file content as a string. Only works within the allowed directory.',
    permissionLevel: 'auto' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return readFile(resolveRoot(), params.path as string);
    },
  },
  {
    name: 'file_write',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Creates intermediate directories as needed.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file within the working directory' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return writeFile(resolveRoot(), params.path as string, params.content as string);
    },
  },
  {
    name: 'file_list',
    description: 'List files and directories. Returns an array of entries with name and type (file/directory). Use recursive: true to include nested contents (max 1000 entries).',
    permissionLevel: 'auto' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: [] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const dirPath = (params.path as string) || '.';
      const recursive = (params.recursive as boolean) || false;
      return listFiles(resolveRoot(), dirPath, recursive);
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a file. Cannot delete directories.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete' },
      },
      required: ['path'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return deleteFile(resolveRoot(), params.path as string);
    },
  },
  {
    name: 'file_move',
    description: 'Move or rename a file. Creates intermediate directories for the destination if needed.',
    permissionLevel: 'confirm' as const,
    parameters: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Current relative path of the file' },
        destination: { type: 'string', description: 'New relative path for the file' },
      },
      required: ['source', 'destination'] as string[],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      return moveFile(resolveRoot(), params.source as string, params.destination as string);
    },
  },
];

export default tools;
```

- [ ] **Шаг 2: Запустить все тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [ ] **Шаг 3: Typecheck**

```bash
npx tsc --noEmit -p packages/tool-files/tsconfig.json
```

Ожидание: нет ошибок.

- [ ] **Шаг 4: Коммит**

```bash
git add packages/tool-files/src/index.ts
git commit -m "feat: export files tools as ToolDefinition array"
```

---

## Задача 7: Финальная интеграция

**Файлы:**
- Изменить: `.env.example`

- [ ] **Шаг 1: Добавить R2_FILES_ROOT в .env.example**

Добавить строку в `.env.example`:

```bash
R2_FILES_ROOT=~/Documents/r2
```

- [ ] **Шаг 2: Установить зависимости**

```bash
cd /Users/dim/code/R2-D2 && npm install
```

- [ ] **Шаг 3: Запустить все тесты**

```bash
npm test
```

Ожидание: все тесты PASS.

- [ ] **Шаг 4: Typecheck всех пакетов**

```bash
npx tsc --noEmit -p packages/shared/tsconfig.json && \
npx tsc --noEmit -p packages/server/tsconfig.json && \
npx tsc --noEmit -p packages/tool-web-search/tsconfig.json && \
npx tsc --noEmit -p packages/tool-files/tsconfig.json && \
npx tsc --noEmit -p packages/client/tsconfig.json
```

Ожидание: нет ошибок типов.

- [ ] **Шаг 5: Коммит**

```bash
git add .env.example package-lock.json
git commit -m "feat: complete Phase 2B — files tool integration"
```
