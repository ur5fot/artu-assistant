# Безопасный локальный маршрут для Qwen3 1.7B

**Date:** 2026-07-13
**Status:** approved design
**Source:** `docs/2026-07-13-qwen3-1.7b-quality.md`

## Цель

Сделать режим Ollama-first предсказуемым для `qwen3:1.7b`: локальная модель
обрабатывает простой разговор и узкие read-only запросы, а задачи, где цена
ошибки или требуемая способность выше, до inference детерминированно уходят в
Claude.

Маленькая модель не должна одновременно решать, каким из 23 tools пользоваться,
соблюдать большой общий prompt, разбирать недоверенный контент и выполнять
изменяющее состояние действие.

## Решения

### 1. Детерминированный pre-router

Router работает обычным TypeScript-кодом и не вызывает отдельную LLM.

Qwen получает только:

- простой разговор без tools;
- один read-only домен: погода, активность, почта, файлы, web, напоминания или
  поиск памяти;
- от 0 до 5 tools выбранного домена.

Claude получает запрос до локального inference, если обнаружено хотя бы одно:

- изменение состояния или опасное действие;
- код, математика, строгий формат/JSON, сложная цепочка рассуждений;
- несколько tool-доменов;
- явно недоверенный вставленный контент вместе с просьбой действовать;
- slash-команда для tool, не входящего в локальный read-only allowlist.

Неуверенность в обычном разговорном запросе не является ошибкой: такой запрос
остаётся локальным без tools. Неуверенность в намерении выполнить действие
маршрутизируется в Claude.

### 2. Локальный allowlist и фазы tool-loop

Локальная модель никогда не получает tools записи, удаления, отправки,
деплоя, изменения памяти или создания/удаления напоминаний. Значение
`permissionLevel` остаётся второй линией защиты, но не определяет локальный
allowlist.

После каждого чтения набор tools сужается:

| Первый tool | Следующая фаза |
|---|---|
| `web_search` | только `web_fetch` |
| `file_list` | только `file_read` |
| `emails_status`, `emails_list` | только `emails_get` |
| terminal read (`web_fetch`, `file_read`, `emails_get` и остальные) | без tools, только синтез ответа |

Локальный loop ограничен четырьмя inference-шагами. Финальный ответ не
проверяется той же Qwen: такой self-review не независим и расходует контекст.
Пустой ответ, запрос отсутствующего tool, ошибка протокола или превышение
лимита ведут в Claude, если локально не было выполнено действие. Локальный
allowlist содержит только чтение, поэтому provider fallback не дублирует
side effects.

### 3. Короткий модульный prompt

Claude сохраняет полный существующий system prompt. Для Qwen используется
короткое общее ядро и одна доменная секция. Tool schemas не дублируются в
тексте prompt; источником контракта является `tools` API.

Memory context и topic summary остаются данными, отделёнными явными границами,
но включаются только после расчёта локального бюджета.

### 4. Отдельный локальный context budget

Лимит Claude `CHAT_CONTEXT_BUDGET_CHARS` не применяется как лимит Qwen.
Локальный budget считается из `OLLAMA_NUM_CTX` (default `8192`), резерва на
ответ и консервативной оценки символов на token.

Сначала учитываются system prompt и JSON schemas выбранных tools. Затем
добавляются bounded memory/topic blocks и целые последние сообщения. Старые
сообщения удаляются целиком; последнее пользовательское сообщение не режется.
Если обязательный статический контекст и текущий запрос не помещаются, запрос
уходит в Claude.

### 5. Structured JSON для узких классификаторов

`OllamaClient.chat` принимает optional `format` с JSON Schema. Почтовые
локальные классификаторы передают схемы, соответствующие их массивам ответов.

JSON Schema гарантирует синтаксис и форму. После `JSON.parse` TypeScript-код
проверяет семантику:

- scorer обязан вернуть каждый запрошенный `uid`, importance ограничивается
  диапазоном 1..5;
- gist принимает только непустые строки для известных писем;
- action match принимает только известные индексы и boolean.

Невалидный или неполный результат не исправляется строковыми эвристиками и не
принимается как правильный: существующий путь переключается в Claude. Отдельный
JSON-router для чата не вводится, потому что route принимается кодом.

### 6. Наблюдаемость и evals

Каждый запрос пишет одну структурированную запись без текста пользователя:
provider, route reason, domain, tool names, оценку prompt tokens, latency и
fallback reason. На первом этапе telemetry остаётся в server logs; миграция БД
не нужна.

Router покрывается табличными eval-тестами: простые локальные запросы, каждый
read-only домен, actions, code/math/strict JSON, multi-domain, slash-команды и
инъекция из недоверенного текста. Набор служит gate для дальнейшего расширения
локального маршрута.

## Поток запроса

```text
user request
    -> deterministic route (domain + risk)
       -> Claude: complex / strict / action / multi-domain / unsafe
       -> Qwen: simple chat or one read-only domain
          -> 0..5 domain tools
          -> optional read-chain with shrinking tool set
          -> synthesis without action tools
          -> protocol/error fallback to Claude
```

## Совместимость

- `LOCAL_LLM_MODE=disabled` по-прежнему полностью отключает Ollama.
- Явный Claude route и Claude-only tools работают как раньше.
- Полный Claude system prompt и permission confirmation не меняются.
- Существующие Discord source events сохраняются.
- Текущие локальные настройки `qwen3:1.7b`, `think=false` сохраняются;
  `num_ctx` становится настраиваемым через `OLLAMA_NUM_CTX`.

## Вне scope

- Embedding-поиск tools и обучаемый RouteLLM до накопления route telemetry.
- Мультиагентная архитектура.
- Автоматическая оценка фактической правильности произвольного текста Qwen.
- Перенос embeddings или memory fact extraction с Voyage/Claude на локальную
  модель.
- Расширение Qwen на tools изменения состояния.

## Acceptance criteria

1. Qwen никогда не получает больше пяти tools и никогда не получает mutating
   tools.
2. Code/math/strict JSON/multi-domain/actions маршрутизируются в Claude до
   локального inference.
3. После terminal read локальный synthesis вызывается без tools.
4. Локальный request гарантированно укладывается в рассчитанный budget или до
   inference уходит в Claude.
5. Ollama JSON-потоки используют JSON Schema и сохраняют независимую
   семантическую проверку/fallback.
6. Route telemetry не содержит пользовательский текст или tool payload.
7. Focused и полный server test/build проходят.
