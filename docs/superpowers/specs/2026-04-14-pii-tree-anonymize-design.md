# PII Tree Anonymization for Tool Results

## Context

`packages/server/src/ai/tool-helpers.ts:200` и `:212` сериализуют структурированные
tool result / tool input в JSON-строку и целиком прогоняют её через
`piiProxy.anonymize(JSON.stringify(...))`. В теле JSON встречаются числовые поля
вроде `timestamp: 1776106975610`, которые regex-based рекогнайзеры Presidio
детектят как `CREDIT_CARD` (13-значные, проходят Luhn) и `PHONE_NUMBER`. В
результате в ответе `memory_search` фигурируют токены типа `<CARD:54f5ea36>` и
`<PHONE:eb5751aa>` вместо timestamp'ов, что:

- ломает JSON-парсинг на клиенте и в tool-loop (результат перестаёт быть валидным JSON);
- заставляет LLM интерпретировать шум как реальные PII-сущности;
- расходует места в токен-vault на мусорные записи.

Основная модель: **PII — это текст, который написал человек.** Числа в
структурированных полях API-ответов по определению не PII; их не нужно
пропускать через Presidio.

## Goals

- Tool result anonymization применяется только к **строковым листьям** JSON-дерева.
- Числа, булевы, `null`, массивы и вложенные объекты сохраняют структуру и типы.
- Собственно регекс-анонимизация текста внутри строк продолжает работать (email, phone, card и т.д.).
- Поведение для обычного пользовательского текста (`tool-loop.ts:47` — `msg.content`) не меняется.

## Non-goals

- Не меняем Presidio recognizer'ы.
- Не добавляем blacklist имён полей.
- Не оптимизируем производительность через batching (отложено до измерений).

## Design

### New module

`packages/server/src/pii/anonymize-tree.ts`:

```ts
import type { PiiProxy, AnonymizeResult } from './proxy.js';

export interface TreeAnonymizeResult {
  value: unknown;
  entities: AnonymizeResult['entities'];
}

export async function anonymizeJsonStringLeaves(
  value: unknown,
  piiProxy: PiiProxy,
): Promise<TreeAnonymizeResult>;
```

Алгоритм (рекурсивный walk):

- `typeof value === 'string'`:
  - пустая строка → вернуть как есть, без вызова Presidio;
  - иначе → `piiProxy.anonymize(value)`; вернуть `{ value: anonText, entities: anonEntities }`.
- `Array.isArray(value)`:
  - рекурсивно обработать каждый элемент, собрать новый массив;
  - объединить `entities` из всех элементов.
- `value !== null && typeof value === 'object'`:
  - построить новый объект, для каждого ключа рекурсивно обработать значение;
  - объединить `entities`.
- Любой примитив (`number`, `boolean`, `null`, `undefined`, `bigint`, `symbol`) → вернуть как есть, `entities: []`.

### Call sites

`packages/server/src/ai/tool-helpers.ts`:

**Строка 199-208** (tool result anonymization) — заменить:

```ts
if (result.data) {
  const anonResult = await piiProxy.anonymize(JSON.stringify(result.data));
  if (anonResult.entities.length > 0) {
    try {
      result = { ...result, data: JSON.parse(anonResult.text) };
    } catch {
      result = { ...result, data: anonResult.text };
    }
  }
}
```

На:

```ts
if (result.data) {
  const anon = await anonymizeJsonStringLeaves(result.data, piiProxy);
  if (anon.entities.length > 0) {
    result = { ...result, data: anon.value };
  }
}
```

**Строка 210-222** (audit log input anonymization) — заменить `piiProxy.anonymize(JSON.stringify(input))` на `anonymizeJsonStringLeaves(input, piiProxy)`. `logInput` становится `anon.value as Record<string, unknown>` (уже объект, парсинг не нужен).

### Unchanged call sites

- `tool-loop.ts:47` — `msg.content` это `string`, а не дерево; `piiProxy.anonymize` остаётся.
- `evals/runner.ts:112-116` — `target.input/expected/actual` тоже строки.
- `tool-loop.ts:82,164` и `ollama-tool-loop.ts:105` — это `deanonymize`, не трогаем.

## Error handling

- Если `piiProxy.anonymize` бросает на конкретном листе — прокидываем исключение наружу (текущее поведение tool-helpers уже оборачивает вызов в `try/catch` выше по стеку).
- Пустые объекты/массивы возвращаются как есть, `entities: []`.

## Tests

Новый файл `packages/server/src/pii/anonymize-tree.test.ts`:

1. **Leaves unchanged for non-strings:** `{ timestamp: 1776106975610, count: 42, active: true, nothing: null }` → value идентичен (референс может быть новый, но значения равны), `entities: []`. Mock `piiProxy.anonymize` — **не вызывается**.
2. **Regression: timestamp + email mix:**
   `{ timestamp: 1776106975610, text: "email: a@b.c" }` → `timestamp` остаётся числом `1776106975610`, `text` проходит через мок анонимайзер. Mock assertion: `anonymize` вызван ровно 1 раз с `"email: a@b.c"`.
3. **Nested structures:**
   `{ a: { b: [{ c: "x" }, { c: 5 }] } }` → строки обрабатываются, числа нет.
4. **Array of primitives:** `[1, 2, "text", true]` → только `"text"` идёт в анонимайзер.
5. **Empty string skipped:** `{ a: "" }` → анонимайзер не вызывается, `entities: []`.
6. **Entity aggregation:** два листа с разными сущностями → итоговый `entities` — union, в том же порядке, в котором обошли дерево.
7. **Null вместо object:** `null` на верхнем уровне → вернуть `null`, `entities: []`, без NPE.

Мок — ручной vitest mock объекта с сигнатурой `PiiProxy` (как в существующих `proxy.test.ts`).

## Verification

1. `cd packages/server && npx vitest run src/pii/anonymize-tree.test.ts` — все кейсы зелёные.
2. `cd packages/server && npx vitest run src/pii` — существующие PII-тесты (presidio, proxy, integration) не сломались.
3. Перезапустить dev сервер. В чате R2: `/память как меня зовут`. Посмотреть `tool_call_result` в SSE-стриме — в `display.content` не должно быть `<CARD:...>` / `<PHONE:...>` на месте timestamp'ов. Email/phone в настоящем тексте продолжают маскироваться.
4. Проверить что `memory_search` tool_result остаётся валидным JSON (клиент парсит без ошибок).

## Rollout

Одна PR / коммит. Backwards-compatible: внешний API tool-helpers не меняется, только внутренности блока анонимизации. Аудит лог получает более чистые входы (объект вместо json-строки в `_raw` fallback).
