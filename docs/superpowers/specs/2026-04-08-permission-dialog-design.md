# Phase 2D: Permission Dialog

## Цель

Inline карточка подтверждения в потоке чата для tools с `confirm` и `forbidden` permission level. Включает запоминание решений и визуальное напоминание при долгом ожидании.

## Уровни Permission

| Уровень | Поведение |
|---------|-----------|
| `auto` | Выполняется сразу без вопросов |
| `confirm` | Карточка подтверждения (серый фон, ⚠ иконка) |
| `forbidden` | Карточка с красным предупреждением "Опасное действие" (красный border, 🔴 иконка), но можно разрешить |

## Поток данных

1. Claude вызывает tool с `confirm` или `forbidden`
2. Сервер проверяет `permission_rules` в SQLite — если есть правило для этого tool, применяет автоматически (allow → выполняет, deny → отклоняет)
3. Если правила нет — сервер отправляет SSE event `tool_confirm_request` клиенту и ждёт ответа (без timeout, ждёт бесконечно)
4. Клиент показывает карточку подтверждения с параметрами tool и кнопками
5. Через 60 секунд без ответа — карточка начинает мигать (CSS animation) как напоминание
6. Пользователь нажимает "Разрешить" или "Отклонить", опционально отмечает "Запомнить"
7. Клиент отправляет `POST /api/confirm { callId, allowed, remember }`
8. Если `remember: true` — сервер сохраняет правило в `permission_rules`
9. Сервер выполняет tool (если allowed) или возвращает отказ Claude, продолжает loop

## Новые SSE события

Добавить в `@r2/shared` types:

```typescript
type SSEEvent =
  | ... // существующие
  | { type: 'tool_confirm_request'; toolCall: ToolCall; level: 'confirm' | 'forbidden' }
```

## Новый API endpoint

### POST /api/confirm

**Request:**
```json
{
  "callId": "string",
  "allowed": true,
  "remember": false
}
```

**Response:** `{ ok: true }`

## Серверная часть

### Механизм ожидания (tool-loop.ts)

Когда tool требует подтверждения и нет сохранённого правила:
1. Создать Promise с externalized resolve
2. Сохранить resolve callback в Map по callId
3. Отправить SSE `tool_confirm_request`
4. `await` Promise — блокирует loop до ответа
5. При получении POST /api/confirm — resolve Promise с результатом

Map хранится в объекте, передаётся из chat route в tool loop через параметры.

### Permission Rules (db.ts)

Новая таблица:

```sql
CREATE TABLE IF NOT EXISTS permission_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL UNIQUE,
  allowed INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Функции:
- `getPermissionRule(toolName: string): { allowed: boolean } | null`
- `savePermissionRule(toolName: string, allowed: boolean): void`
- `clearPermissionRules(): void`

### Confirm Route (routes/confirm.ts)

Новый файл. Принимает POST, находит pending callback по callId, resolve'ит Promise.

### Endpoint для сброса правил

`DELETE /api/permissions` — вызывает `clearPermissionRules()`, возвращает `{ ok: true }`

## Клиентская часть

### PermissionCard.tsx

Компактная inline карточка в потоке чата (вариант A из brainstorm):

**confirm level:**
- Серый фон (`#f8f8f8`), border-radius 14px
- Заголовок: ⚠ иконка + имя tool + "Подтверждение"
- Параметры в code block (key: value, содержимое truncate 3 строки)
- Чекбокс "Запомнить"
- Кнопки: "Разрешить" (синяя `#2A5A8A`) / "Отклонить" (серая border)

**forbidden level:**
- Красный border (2px `#DC2626`), фон `#FEF2F2`
- Заголовок: 🔴 + имя tool + "Опасное действие"
- Остальное аналогично confirm

**После решения:**
- Кнопки заменяются на статус: "✓ Разрешено" (зелёный) или "✗ Отклонено" (красный)
- Карточка становится неактивной (opacity 0.7)

**Напоминание (60 секунд):**
- CSS animation: мягкое мигание border (pulse)
- Без звука, без popup — только визуальный сигнал

### useChat.ts — обработка

- `tool_confirm_request` → добавить в сообщение `pendingConfirm: { callId, level }`
- При клике кнопки → `POST /api/confirm`, обновить состояние карточки

### SSE утилита (sse.ts)

Без изменений — новый event type парсится автоматически.

## Изменения в существующем коде

### shared/types.ts
- Добавить `tool_confirm_request` в SSEEvent union type

### tool-loop.ts
- Убрать текущую блокировку confirm/forbidden (return error)
- Добавить логику: проверить permission_rules → если нет правила, emit SSE + await

### chat.ts (route)
- Создать Map для pending confirms
- Передать в tool loop

### index.ts
- Подключить confirm route
- Подключить permissions route

### db.ts
- Добавить таблицу `permission_rules`
- Добавить функции get/save/clear

## Тестирование

### Серверные тесты
- `db.test.ts`: get/save/clear permission rules
- `tool-loop.test.ts`: confirm tool ждёт ответа и выполняет при allow
- `tool-loop.test.ts`: confirm tool отклоняется при deny
- `tool-loop.test.ts`: saved permission rule auto-applies
- `confirm route test`: POST /api/confirm resolve'ит pending callback
- `permissions route test`: DELETE /api/permissions очищает правила

### Клиентские тесты (ручные, E2E)
- Отправить сообщение которое вызывает file_write
- Карточка подтверждения появляется
- Нажать Разрешить — файл создаётся
- Отправить снова, нажать Отклонить — файл не создаётся
- Отметить "Запомнить" + Разрешить — следующий вызов автоматический
- Подождать 60 секунд — карточка мигает

## Что НЕ входит

- UI для управления сохранёнными правилами (только API `DELETE /api/permissions`)
- Разные UI для разных tools (только confirm vs forbidden стиль)
- Гранулярные правила (по path, по content) — правило на уровне tool_name
