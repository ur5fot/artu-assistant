# Email gist in native language (Russian)

**Date:** 2026-07-02
**Epic:** Pain #1 (email triage) follow-up
**Status:** approved design

## Цель

Каждое входящее письмо выше importance-cutoff получает короткую **суть на
русском (2–3 предложения: о чём письмо + что от тебя ожидается)**, которая
показывается везде, где письмо всплывает: urgent-пинг, дайджест, `emails`-тул.
Это заменяет сырой иноязычный `snippet`, который сейчас юзеру приходится читать
на языке оригинала.

### Контекст (текущее состояние)

- Скорер (`emails/scorer.ts`) выдаёт только `{ uid, importance }` (1–5). Поля
  для «сути» нет.
- `email_pending` хранит `subject`, `snippet` (сырой, ~300 симв, язык оригинала),
  `importance`.
- Показ: urgent-пинг (`emailUrgent.ts`) = `🚨 from / subject / snippet`; дайджест
  (`emailDigest.helpers.ts`) = строки с темой; `emails`-тул (`packages/tool-emails`).
- PII: скорер анонимизирует `from/subject/snippet` через `piiProxy` перед
  отправкой в LLM; сейчас возвращаются только числа, деанонимизация не нужна.
- Тело письма уже декодируется при построении snippet в `imap-client.ts`
  (`pickAndDecode` → `toSnippet`), так что более длинный отрывок доступен без
  доп. IMAP-фетчей.

## Архитектура — двухстадийно

Суть **не смешивается** с importance-скорером. Обоснование:

- importance остаётся чистой числовой задачей → надёжный JSON, гоняется на всех
  письмах, локальная модель не деградирует от смешанной задачи;
- суть — отдельный шаг только для писем `importance ≥ cutoff` (те, что реально
  всплывут) → не тратим токены на newsletter-мусор ниже cutoff;
- модуль изолирован и тестируется независимо.

```
poller tick
  fetch NewMessage[] (subject + расширенный отрывок тела)
    → scoreBatch()  → importance для всех
    → для писем importance ≥ cutoff:
         summarizeGists()  → суть на русском (Ollama→Claude, PII deanon)
    → store email_pending (importance + snippet + gist)
```

## Компоненты

### 1. `emails/gist.ts` (новый модуль)

`summarizeGists(msgs: GistInput[], deps: GistDeps): Promise<Map<number, string>>`

- `GistInput = { uid, from, subject, body }` где `body` — расширенный отрывок
  (~800–1000 симв, из уже декодированного тела).
- Промпт (русский): «выжми суть, 2–3 предложения — о чём письмо и что ожидается
  от получателя; только суть, без преамбул».
- Ollama-first (если `LOCAL_LLM_MODE=enabled`) → Claude fallback, тот же паттерн
  что в `scorer.ts`.
- **Best-effort:** нет валидной сути для uid → просто отсутствует в Map. Никогда
  не бросает из-за отсутствия сути (в отличие от `normalize` в скорере, который
  требует importance для каждого uid). Суть опциональна; importance критичен.
- Ошибка обоих провайдеров / парсинга → пустой вклад для затронутых uid
  (лог warn), обработка письма продолжается со snippet-fallback.

### 2. PII round-trip

Вход в LLM анонимизируется через `piiProxy.anonymize` (как в скорере). Ответ
модели содержит плейсхолдеры (`<PERSON:ab12>` и т.п.) → перед возвратом из
`summarizeGists` каждая суть прогоняется через `piiProxy.deanonymize(gist)`,
восстанавливая реальные данные. Используется тот же `piiProxy`-инстанс, что и в
скоринге (общая mapping-сессия).

### 3. Хранение

Новая колонка `gist TEXT` (nullable) в `email_pending`. Аддитивная миграция.
Старые строки и промахи → `NULL`. `EmailPendingRow` получает `gist: string | null`.

### 4. Wiring в поллере (`multi-account-poller.ts`)

После `scoreBatch`: для писем с `importance ≥ importanceCutoff` собрать
`GistInput[]` (с расширенным отрывком тела), вызвать `summarizeGists`, положить
результат в `email_pending` вместе с importance/snippet. Ниже cutoff — `gist` не
считается (остаётся NULL). Расширенный отрывок тела прокидывается из fetcher'а
(увеличить лимит отрывка, доступного поллеру, без доп. фетча).

### 5. Показ

- **Urgent-пинг** (`emailUrgent.ts`): при наличии `gist` строка сути **заменяет**
  сырой snippet → `🚨 <from>\n<subject>\n<gist>`. Нет `gist` → fallback на
  snippet (текущее поведение).
- **Дайджест** (`emailDigest.helpers.ts`): в строку письма добавляется суть
  (при наличии), с усечением под лимиты Discord.
- **`emails`-тул** (`packages/tool-emails`): выдача `emails_list`/`emails_get`
  включает поле `gist`.
- Оригинал тела всегда доступен через `emails_get` (полный текст) — суть не
  скрывает исходник.

### 6. Feature flag

`EMAIL_GIST_ENABLED` (env, default `false`). Шип dark. При off — суть не
считается и не показывается, поведение идентично текущему (сырой snippet везде).

## Язык

Хардкод русский (основной язык юзера). Украинский/детекция языка — вне scope,
добавляется позже при явной потребности.

## Data flow

```
NewMessage(subject, bodyExcerpt)
  → scoreBatch → importance
  → [importance ≥ cutoff] anonymize(subject,body) → LLM (ru gist) → deanonymize → gist
  → email_pending{ importance, snippet, gist }
       → emailUrgent: 🚨 from / subject / gist(||snippet)
       → emailDigest: line + gist
       → emails tool: { ..., gist }
```

## Error handling

- Gist LLM провал (оба провайдера / парсинг) → gist отсутствует для uid,
  лог warn, письмо сохраняется со snippet-fallback. Никогда не блокирует
  importance-путь.
- PII deanon провал одной сути → эту суть отбрасываем (лог), snippet-fallback.
- Flag off → весь gist-путь пропускается.

## Тестирование

- **gist-модуль:** Ollama-success; Ollama-fail→Claude fallback; парс-промах для
  части uid → нет их в Map; PII deanon восстанавливает плейсхолдеры; оба
  провайдера упали → пустой результат, не throw.
- **поллер:** gist считается и пишется для `importance ≥ cutoff`; НЕ считается для
  ниже cutoff; flag off → summarizeGists не зовётся.
- **показ:** urgent-пинг заменяет snippet сутью при наличии / fallback на snippet
  при NULL; дайджест включает суть с усечением; `emails`-тул отдаёт gist.
- **миграция:** колонка `gist` добавляется, старые строки читаются как NULL.

## Acceptance criteria

1. При `EMAIL_GIST_ENABLED=true` письмо `importance ≥ cutoff` получает суть на
   русском (2–3 предложения) в `email_pending.gist`.
2. Urgent-пинг показывает суть вместо сырого snippet; при отсутствии сути —
   snippet.
3. Дайджест и `emails`-тул показывают суть.
4. Реальные PII в сути восстановлены (не плейсхолдеры).
5. Письма ниже cutoff и режим flag-off не тратят токены на суть; поведение как
   сейчас.
6. Любой провал gist/deanon → snippet-fallback, importance-путь не затронут.
7. Весь тестовый набор зелёный + новые тесты выше.

## Post-Completion

**Активация:** `EMAIL_GIST_ENABLED=true` в рантайм-`.env` на хосте, рестарт.

**Manual verification:** дождаться реального входящего письма (или прогнать через
тестовый ящик) на иностранном языке → проверить, что пинг показывает связную суть
на русском с корректными именами/суммами.
