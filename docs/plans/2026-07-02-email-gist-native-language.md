# Email gist in native language (Russian)

## Overview

Каждое входящее письмо `importance ≥ cutoff` получает короткую **суть на русском
(2–3 предложения: о чём + что от тебя ожидается)**, показываемую в urgent-пинге,
дайджесте и `emails`-туле вместо сырого иноязычного snippet. Отдельный gist-шаг
(не смешан с importance-скорером), best-effort, за флагом `EMAIL_GIST_ENABLED`
(default off). Оригинал тела всегда доступен через `emails_get`.

Design spec: `docs/superpowers/specs/2026-07-02-email-gist-native-language-design.md`.

## Context (from discovery)

- Files/components involved:
  - `packages/server/src/db.ts` (~279) — миграция `email_pending`: паттерн
    `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN`.
  - `packages/server/src/emails/types.ts` — `EmailPendingRow` (+ `gist`),
    `NewMessage` (+ `bodyExcerpt`).
  - `packages/server/src/emails/store.ts` (~205 `insertPending`) — писать `gist`.
  - `packages/server/src/emails/gist.ts` — **новый** модуль-суммаризатор.
  - `packages/server/src/emails/scorer.ts` — эталон Ollama→Claude + PII anonymize.
  - `packages/server/src/emails/imap-client.ts` (`SNIPPET_LEN=500`, ~229) —
    добавить `bodyExcerpt` из уже декодированного `text`.
  - `packages/server/src/emails/multi-account-poller.ts` — после скоринга вызвать
    gist для писем ≥ cutoff, прокинуть в `insertPending`.
  - `packages/server/src/cognition/handlers/emailUrgent.ts` (~91-94) — gist
    заменяет snippet в `content`.
  - `packages/server/src/cognition/handlers/emailDigest.helpers.ts` (~104-107
    `formatRow`) — добавить gist в строку.
  - `packages/tool-emails/src/index.ts` (~12-18 `toModel`) + `types.ts` — поле gist.
  - `packages/server/src/index.ts` — флаг `EMAIL_GIST_ENABLED` + прокидка
    gist-деп (piiProxy/ollama/anthropic) в поллер, зеркаля scorer-wiring.
- Related patterns found:
  - Scorer: PII `anonymize` перед LLM, Ollama-first→Claude fallback, `extractJson`.
    Gist добавляет обратный `piiProxy.deanonymize` (скорер этого не делал — числа).
  - Миграция аддитивной колонкой: `urgent_pinged_at` (`db.ts:279-282`).
  - `insertPending` — `INSERT OR IGNORE`, явный список колонок.
- Dependencies identified: `piiProxy`, `OllamaClient`, `Anthropic` уже собраны в
  index.ts для скорера — переиспользуются для gist.

## Development Approach

- **Testing approach**: Regular (код, затем тесты в той же задаче) — как весь
  server-набор (vitest, colocated `*.test.ts`).
- Каждую задачу довожу до конца перед следующей; мелкие фокусные изменения.
- **CRITICAL: каждая задача включает новые/обновлённые тесты** (success + error).
- **CRITICAL: все тесты зелёные до перехода к следующей задаче.**
- Backward-compat: флаг off → поведение идентично текущему (сырой snippet везде),
  NULL-gist читается как «нет сути».
- Обновлять этот файл при сдвиге scope.

## Testing Strategy

- **Unit tests** (vitest) на каждую задачу. E2E-харнесса в пакете нет — логику
  показа тестируем юнитами со стаб-строками `email_pending`.

## Progress Tracking

- `[x]` сразу по факту; `➕` новые задачи; `⚠️` блокеры.

## What Goes Where

- Implementation Steps: код, тесты, доки в репо.
- Post-Completion: активация флага в рантайме, ручная проверка на реальном письме.

## Implementation Steps

### Task 1: DB-миграция + store + типы для `gist`
- [x] `db.ts`: после блока `urgent_pinged_at` — `PRAGMA table_info(email_pending)`,
      если нет `gist` → `ALTER TABLE email_pending ADD COLUMN gist TEXT`
- [x] `types.ts`: `EmailPendingRow.gist: string | null`
- [x] `store.ts` `insertPending`: принять `gist` (nullable) и писать в колонку
      (расширить список колонок INSERT)
- [x] write tests: миграция добавляет колонку; старые строки читаются `gist=null`;
      `insertPending` пишет и читает gist (в т.ч. null)
- [x] run tests — must pass before Task 2

### Task 2: Модуль `emails/gist.ts`
- [ ] `summarizeGists(msgs: GistInput[], deps: GistDeps): Promise<Map<number,string>>`,
      `GistInput = { uid, from, subject, body }`, `GistDeps = { piiProxy, ollama,
      anthropic, signal }`
- [ ] русский промпт: суть 2–3 предложения (о чём + что ожидается), ответ JSON
      `[{uid, gist}]`; `extractJson` как в scorer
- [ ] Ollama-first (при `LOCAL_LLM_MODE=enabled`) → Claude fallback
- [ ] PII: `anonymize(from/subject/body)` перед LLM, `deanonymize(gist)` перед
      возвратом; тем же `piiProxy`
- [ ] best-effort: uid без валидной сути отсутствует в Map; оба провайдера/парс
      упали → пустой Map для батча (лог warn), НЕ throw
- [ ] write tests: Ollama success; Ollama-fail→Claude; частичный промах uid →
      нет в Map; deanonymize восстанавливает плейсхолдеры; оба провайдера упали →
      пустой Map без throw
- [ ] run tests — must pass before Task 3

### Task 3: `bodyExcerpt` + wiring в поллере (за флагом)
- [ ] `types.ts`: `NewMessage.bodyExcerpt?: string`; `imap-client.ts` — заполнять
      из того же декодированного `text` (лимит ~1200, отдельно от `SNIPPET_LEN`)
- [ ] `multi-account-poller.ts`: опциональный `gister?: (msgs) => Promise<Map>` +
      `gistEnabled` + `importanceCutoff`; после `scoreBatch` для писем
      `importance ≥ cutoff` собрать `GistInput[]` (body = `bodyExcerpt ?? snippet`),
      вызвать `gister`, положить `gist` в `insertPending`
- [ ] gist ниже cutoff / `gistEnabled=false` → не вызывается, `gist=null`
- [ ] gist-провал не ломает ingest письма (importance-путь неизменен)
- [ ] write tests: gist пишется для ≥cutoff и не для ниже; flag off → gister не
      зван; провал gister → письмо всё равно сохранено (gist=null)
- [ ] run tests — must pass before Task 4

### Task 4: Показ — urgent-пинг
- [ ] `emailUrgent.ts`: если `row.gist` не пуст → `content = 🚨 from\nsubject\n<gist>`;
      иначе fallback на текущий snippet-путь (усечение как есть)
- [ ] write tests: gist присутствует → в content суть, не snippet; gist null →
      snippet (текущее поведение)
- [ ] run tests — must pass before Task 5

### Task 5: Показ — дайджест + `emails`-тул
- [ ] `emailDigest.helpers.ts` `formatRow`: при наличии `gist` использовать его
      как summary-часть (с усечением `SUMMARY_CHARS`), иначе snippet
- [ ] `tool-emails` `toModel` + `types.ts`: добавить `gist` в выдачу
      `emails_list`/`emails_get`
- [ ] write tests: дайджест-строка с gist / fallback на snippet; тул отдаёт gist
- [ ] run tests — must pass before Task 6

### Task 6: Флаг + wiring в index.ts
- [ ] `index.ts`: `gistEnabled = process.env.EMAIL_GIST_ENABLED === 'true'`;
      собрать `gister` через `summarizeGists` с теми же piiProxy/ollama/anthropic,
      что у скорера; прокинуть `gister`/`gistEnabled`/`importanceCutoff` в поллер
- [ ] лог состояния флага рядом с email-инициализацией
- [ ] write/extend tests на wiring, если есть startup-тест; иначе покрыто
      юнитами поллера/модуля
- [ ] run tests — must pass before Task 7

### Task 7: Verify acceptance criteria
- [ ] flag on → письмо ≥cutoff получает русскую суть в `email_pending.gist`
- [ ] urgent-пинг показывает суть / fallback snippet при null
- [ ] дайджест и тул показывают суть
- [ ] PII в сути восстановлены (не плейсхолдеры)
- [ ] ниже cutoff и flag-off не тратят токены; поведение как сейчас
- [ ] провал gist/deanon → snippet-fallback, importance-путь не затронут
- [ ] полный server-набор + линтер зелёные; coverage на новом модуле

### Task 8: Документация
- [ ] `EMAIL_GIST_ENABLED` в `AGENTS.md` (env-секция) + `.env.example`
- [ ] описать поведение сути в email-секции `README.md`

## Technical Details

- `gist` — nullable `TEXT` в `email_pending`; NULL = нет сути (старые строки,
  ниже cutoff, промах/провал, flag off).
- Gist LLM-контракт: JSON `[{ "uid": <int>, "gist": "<ru 2-3 предложения>" }]`.
- PII: anonymize вход → LLM → deanonymize выход, тем же `piiProxy` (общая mapping).
- `bodyExcerpt` (~1200) отдельно от `snippet` (500): суть получает больше
  контекста, snippet остаётся для показа/fallback. Оба из одного декодированного
  тела — без доп. IMAP-фетчей.
- Двухстадийно: `scoreBatch` (все письма, importance) → `summarizeGists` (только
  ≥cutoff). importance-надёжность не зависит от gist.

## Post-Completion

**Активация:** `EMAIL_GIST_ENABLED=true` в рантайм-`.env` на хосте + рестарт
`com.r2.supervisor`. Требует уже включённого email-watcher.

**Manual verification:** дождаться реального входящего письма (или тестовый ящик)
на иностранном языке → пинг показывает связную русскую суть с корректными
именами/суммами (PII восстановлены).
