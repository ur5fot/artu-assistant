# Phase 3B: Chat Persistence

## Цель

Сохранение истории чата в SQLite чтобы разговор переживал рестарт worker'а. Один активный чат, полные сообщения с tool calls. Клиент загружает историю при старте через GET endpoint.

## Хранение

### Таблица `chat_messages` в r2.db

```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  pii_entities TEXT,
  timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `message_id` — UUID из клиента (Message.id), UNIQUE для идемпотентности
- `tool_calls` — JSON string of `ToolCall[]` (nullable, только для assistant)
- `pii_entities` — JSON string of `Array<{type, count}>` (nullable)
- `timestamp` — Unix ms из Message.timestamp

### Функции в db.ts

```typescript
interface SaveMessageParams {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  piiEntities?: Array<{ type: string; count: number }>;
  timestamp: number;
}

function saveMessage(params: SaveMessageParams): void
function getMessages(): Message[]
function clearMessages(): void
```

- `saveMessage()` — INSERT OR IGNORE (идемпотентно по message_id)
- `getMessages()` — SELECT ORDER BY timestamp ASC, парсит JSON поля в объекты
- `clearMessages()` — DELETE FROM chat_messages

## Серверная интеграция

### Сохранение сообщений в chat route

В `routes/chat.ts`:
1. При получении POST /api/chat — сохранить user message (`saveMessage()`)
2. В `onEvent` callback — при `done` event сохранить assistant message (собранный из text_delta + tool_calls)

Для сборки assistant message — chat route накапливает text и toolCalls из SSE events (аналогично тому как делает клиент в useChat).

### Новый endpoint

`GET /api/messages` — возвращает `getMessages()` как JSON массив `Message[]`.

Новый файл `routes/messages.ts`:

```typescript
router.get('/messages', (_req, res) => {
  const messages = getMessages();
  res.json(messages);
});
```

### Регистрация в index.ts

```typescript
import { createMessagesRouter } from './routes/messages.js';
app.use('/api', createMessagesRouter());
```

## Клиентская интеграция

### useChat — загрузка при старте

При монтировании `useChat`:
1. Вызвать `GET /api/messages`
2. Установить `messages` state из ответа
3. До загрузки — `loading = true`

```typescript
useEffect(() => {
  fetch('/api/messages')
    .then(res => res.json())
    .then(msgs => setMessages(msgs))
    .catch(err => console.error('Failed to load history:', err));
}, []);
```

## Тестирование

### Серверные тесты (Vitest)
- `db.test.ts`: saveMessage + getMessages round-trip
- `db.test.ts`: saveMessage с tool_calls JSON
- `db.test.ts`: clearMessages удаляет все
- `db.test.ts`: saveMessage идемпотентен (INSERT OR IGNORE)
- `messages route`: GET /api/messages возвращает сохранённые сообщения

### Ручные
- Отправить сообщение → перезапустить сервер → открыть чат → история на месте
- Сообщение с tool call → перезапуск → tool call виден
- Пустой чат → GET /api/messages → пустой массив

## Изменения в существующем коде

### db.ts
- Добавить таблицу `chat_messages` в `initDb()`
- Добавить функции `saveMessage()`, `getMessages()`, `clearMessages()`

### routes/chat.ts
- Накапливать assistant text и toolCalls из SSE events
- Сохранять user message при получении
- Сохранять assistant message при `done` event

### routes/messages.ts (новый)
- GET /api/messages endpoint

### index.ts
- Подключить messages route

### client/hooks/useChat.ts
- Загрузить историю при монтировании

## Что НЕ входит

- Множественные чаты / история чатов
- UI кнопка "новый чат"
- Пагинация / лимит сообщений
- Поиск по истории
- Экспорт чата
