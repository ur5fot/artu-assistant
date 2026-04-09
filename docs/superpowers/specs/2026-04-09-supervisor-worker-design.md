# Phase 3A: Supervisor + Worker Split

## Цель

Разделить R2 на два процесса: supervisor (процесс-менеджер) и worker (бизнес-логика). Supervisor спавнит worker, рестартует при краше, отправляет статус через WebSocket. Фронт подключается к обоим: worker для чата, supervisor для статуса. Dev workflow не меняется.

## Архитектура

```
                         ┌──────────────────────────┐
                         │    Supervisor (:3100)     │
                         │  - WebSocket server       │
                         │  - Worker process manager │
                         │  - Auto-restart + backoff │
                         └────────┬─────────────────┘
                                  │ child_process (IPC)
                                  ▼
                         ┌──────────────────────────┐
                         │    Worker (:3001)         │
                         │  - Express HTTP + SSE     │
                         │  - Claude API + tools     │
                         │  - Existing R2 server     │
                         └──────────────────────────┘

  Browser:
    - HTTP/SSE → Worker :3001 (чат, tools, confirm)
    - WebSocket → Supervisor :3100 (статус worker'а)
```

## Пакет `@r2/supervisor`

Новый workspace `packages/supervisor/`.

### Entry point (`index.ts`)

- Загружает `.env` из корня проекта
- Создаёт WorkerManager
- Создаёт WS сервер
- Связывает события WorkerManager → WS broadcast
- Запускает первый worker

### WorkerManager (`worker-manager.ts`)

Управление lifecycle worker процесса.

**Spawn:**
- `child_process.fork()` для `packages/server/dist/index.js` (prod) или `npx tsx packages/server/src/index.ts` (если dist не существует)
- Передаёт env переменные из process.env
- Слушает IPC: `message` event с `{ type: 'ready' }`
- Слушает `exit` event для auto-restart

**Graceful restart:**
1. Отправить SIGTERM worker'у
2. Ждать `R2_SHUTDOWN_TIMEOUT` ms (default 5000, env configurable)
3. Если worker не умер — SIGKILL
4. Спавнить новый worker

**Auto-restart при краше (backoff):**
- 1-й краш: рестарт сразу
- 2-й краш: через 2 секунды
- 3-й краш: через 5 секунд
- После 3 крашей за 60 секунд: пауза 30 секунд, потом сброс счётчика
- Логирование каждого краша и рестарта

**Интерфейс событий:**
```typescript
interface WorkerManagerEvents {
  'worker_starting': () => void;
  'worker_ready': () => void;
  'worker_crashed': (code: number | null, signal: string | null) => void;
  'worker_restarting': (delayMs: number) => void;
}
```

### WebSocket сервер (`ws-server.ts`)

Порт: `R2_SUPERVISOR_PORT` env (default 3100).

**Исходящие события (supervisor → клиент):**
```typescript
type SupervisorEvent =
  | { type: 'worker_starting' }
  | { type: 'worker_ready' }
  | { type: 'worker_crashed'; code: number | null; signal: string | null }
  | { type: 'worker_restarting'; delayMs: number };
```

**Входящие команды (клиент → supervisor):**
```typescript
type SupervisorCommand =
  | { type: 'restart' }   // для Phase 3F
  | { type: 'status' };   // запросить текущий статус
```

При подключении нового клиента — сразу отправить текущий статус worker'а.

### package.json

```json
{
  "name": "@r2/supervisor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node dist/index.js",
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@r2/shared": "*",
    "ws": "^8.16.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.10",
    "typescript": "^5.7.0"
  }
}
```

## Изменения в `@r2/server` (worker)

### index.ts

После `app.listen()` callback:
```typescript
// Signal supervisor that worker is ready (no-op without supervisor)
process.send?.({ type: 'ready' });
```

Добавить SIGTERM handler:
```typescript
process.on('SIGTERM', () => {
  console.log('Worker received SIGTERM, shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});
```

Сохранить return value `app.listen()` в переменную `server` для graceful shutdown.

## Изменения в `@r2/client`

### useSupervisor.ts (новый хук)

```typescript
interface SupervisorState {
  workerStatus: 'running' | 'starting' | 'crashed' | 'restarting' | 'unknown';
  connected: boolean;
}
```

- Подключается к `ws://localhost:${R2_SUPERVISOR_PORT || 3100}`
- Парсит входящие события, обновляет состояние
- Auto-reconnect с backoff при потере соединения (1s → 2s → 5s → 10s max)
- Если WS недоступен (dev режим): `workerStatus = 'running'`, `connected = false`

### App.tsx

Показать индикатор при `workerStatus !== 'running'`:
- `starting` / `restarting` → полоска сверху "R2 is restarting..." с пульсирующей анимацией, фон `#fef3c7`
- `crashed` → красная полоска "R2 crashed, restarting...", фон `#fee2e2`
- Полноценный статус-бар с деталями — Phase 3F

### Env переменная для клиента

Vite env: `VITE_SUPERVISOR_WS_URL=ws://localhost:3100` (default).

## Конфигурация

### Env переменные

```bash
# Supervisor
R2_SUPERVISOR_PORT=3100
R2_SHUTDOWN_TIMEOUT=5000
```

### Скрипты в корневом package.json

```json
{
  "start": "node packages/supervisor/dist/index.js",
  "start:build": "npm run build --workspaces && npm start",
  "dev": "npm run dev --workspace=@r2/server & npm run dev --workspace=@r2/client"
}
```

`npm run dev` — без supervisor, как сейчас.
`npm start` — через supervisor (prod).

## Тестирование

### Серверные тесты (Vitest)

- `worker-manager.test.ts`: spawn worker, получить ready signal
- `worker-manager.test.ts`: graceful restart — SIGTERM → wait → SIGKILL
- `worker-manager.test.ts`: auto-restart при краше, backoff delays
- `worker-manager.test.ts`: пауза после 3 крашей за 60 секунд
- `ws-server.test.ts`: клиент подключается, получает текущий статус
- `ws-server.test.ts`: broadcast worker_ready/worker_crashed всем клиентам

### Ручные

- `npm start` — supervisor стартует, worker поднимается, чат работает
- Убить worker процесс (`kill <PID>`) — supervisor рестартует, фронт показывает "restarting"
- `npm run dev` — работает как раньше без supervisor
- Убить worker 3 раза подряд — backoff увеличивается, после 3-го пауза 30 сек

## Что НЕ входит

- Git watcher (Phase 3D)
- Chat persistence / буферизация сообщений при рестарте (Phase 3B)
- Чат-команды `r2 restart` (Phase 3F — handler для WS команды `restart` добавлен, но UI нет)
- Полноценный статус-бар (Phase 3F)
- Проксирование HTTP через supervisor
- Мониторинг worker'а через healthcheck HTTP (supervisor использует только IPC/exit events)
