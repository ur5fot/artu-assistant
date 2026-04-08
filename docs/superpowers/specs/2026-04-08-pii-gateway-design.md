# Phase 2C: PII Gateway

## Цель

Proxy-слой анонимизации персональных данных через Microsoft Presidio. Все данные между пользователем, Claude API и tool'ами проходят через единый модуль. Замаскированные данные хранятся в зашифрованном vault (SQLite + AES-256). UI показывает badge о замаскированных сущностях.

## Архитектура

### Proxy Layer

Единый модуль `pii-proxy.ts` с двумя основными функциями:

- **`anonymize(text)`** — вызывает Presidio Analyzer (детекция) → Anonymizer (замена), подставляет плейсхолдеры `<TYPE:hash>`, сохраняет маппинг в vault
- **`deanonymize(text)`** — ищет плейсхолдеры регулярным выражением, достаёт оригиналы из vault, подставляет обратно

Proxy передаётся в tool-loop как параметр (аналогично `pendingConfirms`). При `PII_MODE=disabled` — pass-through объект.

### Data Flow

```
User input
  → anonymize() → Claude API (видит плейсхолдеры)
    → Claude возвращает tool_use с плейсхолдерами
      → deanonymize() параметров → tool handler (работает с реальными данными)
        → tool result → anonymize() → обратно в Claude
          → Claude финальный ответ с плейсхолдерами
            → deanonymize() → SSE text_delta клиенту (реальные данные)

Audit log ← пишем анонимизированные данные (плейсхолдеры)
```

## Presidio — Docker контейнеры

Два официальных образа Microsoft, добавляются в `docker-compose.yml`:

```yaml
r2-presidio-analyzer:
  image: mcr.microsoft.com/presidio-analyzer:latest
  container_name: r2-presidio-analyzer
  ports:
    - "127.0.0.1:5002:5002"

r2-presidio-anonymizer:
  image: mcr.microsoft.com/presidio-anonymizer:latest
  container_name: r2-presidio-anonymizer
  ports:
    - "127.0.0.1:5001:5001"
```

Оба на `127.0.0.1`, недоступны извне. Запуск: `docker compose up -d` поднимает все 3 контейнера (SearXNG + 2× Presidio).

### Presidio API

**Analyzer** (`POST http://localhost:5002/analyze`):
```json
{
  "text": "My email is john@acme.com",
  "language": "en",
  "entities": ["EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "IBAN_CODE"]
}
```
Response: массив `{ entity_type, start, end, score }`.

**Anonymizer** (`POST http://localhost:5001/anonymize`):
```json
{
  "text": "My email is john@acme.com",
  "analyzer_results": [{ "start": 12, "end": 25, "score": 0.95, "entity_type": "EMAIL_ADDRESS" }],
  "operators": {
    "EMAIL_ADDRESS": { "type": "replace", "new_value": "<EMAIL:a7f3>" }
  }
}
```
Response: `{ text: "My email is <EMAIL:a7f3>", items: [...] }`.

## Token Vault

### Формат плейсхолдеров

`<TYPE:hash>` — где:
- `TYPE` — сокращённый тип сущности (маппинг из Presidio entity types)
- `hash` — первые 4 символа HMAC-SHA256 от оригинального значения (ключ = `PII_ENCRYPTION_KEY`)

Одинаковый PII → одинаковый токен. Claude может отслеживать одинаковые сущности через разные сообщения.

### Маппинг типов (Presidio → плейсхолдер)

| Presidio entity | Placeholder type |
|-----------------|-----------------|
| `EMAIL_ADDRESS` | `EMAIL` |
| `PHONE_NUMBER` | `PHONE` |
| `CREDIT_CARD` | `CARD` |
| `IBAN_CODE` | `IBAN` |
| `IP_ADDRESS` | `IP` |
| `PERSON` | `PERSON` |
| `LOCATION` | `LOCATION` |
| `DATE_TIME` | `DATE` |
| `US_SSN` | `SSN` |
| `US_DRIVER_LICENSE` | `LICENSE` |
| остальные | первое слово entity type |

### SQLite таблица

```sql
CREATE TABLE IF NOT EXISTS pii_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  encrypted_value TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT DEFAULT (datetime('now', '+7 days'))
);
```

### Шифрование

- Алгоритм: AES-256-GCM
- Формат `encrypted_value`: `base64(IV + ciphertext + auth_tag)`
- Ключ: `PII_ENCRYPTION_KEY` из `.env`
- При первом запуске, если ключа нет — генерируем `crypto.randomBytes(32).toString('hex')` и пишем в `.env`

### Функции (db.ts)

- `savePiiToken(token: string, value: string, entityType: string): void`
- `getPiiToken(token: string): { value: string; entityType: string } | null`
- `clearExpiredPiiTokens(): void`
- `clearAllPiiTokens(): void`

## Интеграция с tool-loop

### Точки перехвата

1. **User message** → `proxy.anonymize(content)` перед отправкой в Claude API
2. **Tool params** (Claude → tool) → `proxy.deanonymize(JSON.stringify(params))` перед вызовом handler
3. **Tool result** (tool → Claude) → `proxy.anonymize(JSON.stringify(result))` перед возвратом в Claude
4. **SSE text_delta** (Claude → client) → `proxy.deanonymize(content)` перед отправкой клиенту
5. **Audit log** → пишем как есть (данные уже анонимизированы на этапе 1/3)

### Интерфейс proxy

```typescript
interface PiiProxy {
  anonymize(text: string): Promise<AnonymizeResult>;
  deanonymize(text: string): Promise<string>;
}

interface AnonymizeResult {
  text: string;
  entities: Array<{ type: string; token: string }>;
}
```

## Новые SSE события

Добавить в `@r2/shared` types:

```typescript
type SSEEvent =
  | ... // существующие
  | { type: 'pii_masked'; messageId: string; entities: Array<{ type: string; count: number }> }
```

## UI — PII Badge

### PiiBadge.tsx

Компонент внутри `MessageBubble`:
- Показывается если в сообщении были замаскированы PII
- Свёрнутый: `🛡 3 PII masked`
- Развёрнутый (по клику): `2× EMAIL, 1× PHONE`
- Стиль: фон `#f0f9ff`, border `#bae6fd`, border-radius 8px, font-size 12px

### useChat.ts — обработка

- `pii_masked` → сохранить entities в состоянии сообщения
- `MessageBubble` проверяет наличие PII данных → рендерит `PiiBadge`

## Конфигурация

### Env переменные (.env.example)

```bash
PII_MODE=optional              # required | optional | disabled
PII_ENCRYPTION_KEY=            # auto-generated on first run if empty
PII_ENTITY_TYPES=EMAIL_ADDRESS,PHONE_NUMBER,CREDIT_CARD,IBAN_CODE
PRESIDIO_ANALYZER_URL=http://localhost:5002
PRESIDIO_ANONYMIZER_URL=http://localhost:5001

# All available Presidio entity types:
# EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD, IBAN_CODE, IP_ADDRESS,
# PERSON, LOCATION, DATE_TIME, NRP, MEDICAL_LICENSE,
# US_SSN, US_DRIVER_LICENSE, UK_NHS, SG_NRIC_FIN, AU_ABN,
# AU_ACN, AU_TFN, AU_MEDICARE, US_PASSPORT, US_BANK_NUMBER
```

### Режимы PII_MODE

| Режим | Presidio недоступен | Поведение |
|-------|---------------------|-----------|
| `required` | Ошибка, чат не работает | Блокирует отправку в Claude API |
| `optional` (default) | Warning + pass-through | Логирует warning, отправляет SSE предупреждение клиенту, данные идут как есть |
| `disabled` | — | Proxy pass-through, контейнеры не нужны |

## Изменения в существующем коде

### shared/types.ts
- Добавить `pii_masked` в SSEEvent union type

### tool-loop.ts
- Принять `PiiProxy` как параметр
- Обернуть user messages, tool params, tool results, SSE output через proxy
- Audit log пишет анонимизированные данные

### chat.ts (route)
- Создать PiiProxy инстанс (или pass-through при disabled)
- Передать в tool loop

### index.ts
- Инициализировать PII vault (таблица + auto-generate key)

### db.ts
- Добавить таблицу `pii_tokens`
- Добавить функции save/get/clear

### docker-compose.yml
- Добавить два Presidio сервиса

### .env.example
- Добавить PII переменные с полным списком типов

## Тестирование

### Серверные тесты (Vitest)
- `pii-proxy.test.ts`: anonymize/deanonymize round-trip
- `pii-proxy.test.ts`: консистентность хешей (один PII → один токен)
- `pii-proxy.test.ts`: несколько PII в одном тексте
- `pii-proxy.test.ts`: fail-open (mode=optional, Presidio недоступен)
- `pii-proxy.test.ts`: fail-closed (mode=required, Presidio недоступен)
- `vault.test.ts`: encrypt/decrypt AES-256-GCM round-trip
- `vault.test.ts`: HMAC хеш стабилен для одного значения
- `vault.test.ts`: clearExpiredPiiTokens удаляет старые записи
- `tool-loop.test.ts`: данные проходят через proxy
- `tool-loop.test.ts`: audit log содержит плейсхолдеры, не реальные данные

### Ручные / E2E
- Отправить сообщение с email → badge "🛡 1 PII masked" появляется
- Claude отвечает с реальным email (деанонимизировано)
- Audit log содержит `<EMAIL:a7f3>`, не реальный адрес
- Остановить Presidio контейнер → warning в UI, чат работает (optional mode)
- `PII_MODE=disabled` → никакой анонимизации, badge не показывается

## Что НЕ входит

- Анонимизация изображений/файлов (только текст)
- UI для управления vault (только API `DELETE /api/pii-tokens`)
- Кастомные recognizer'ы для Presidio (только встроенные)
- Анонимизация system prompt
- Мультиязычная детекция (только `en`, Presidio default)
