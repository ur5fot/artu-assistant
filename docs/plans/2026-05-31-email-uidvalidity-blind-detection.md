# Email-Watcher UIDVALIDITY Blind-Detection — Pain #1 / Email iter (self-heal)

## Overview

**Проблема.** Email watcher (`multi-account-poller.ts` + `imap-client.ts`)
хранит per-account `last_seen_uid` в `email_account_state` как «голое» целое —
**без пары `UIDVALIDITY`** (grep подтверждает: в `packages/server/src/emails/`
нет ни одного обращения к uidvalidity). IMAP-UID стабильны только пока неизменен
`UIDVALIDITY` мейлбокса. Если провайдер пересоздаёт/ресетит мейлбокс
(`UIDVALIDITY` меняется → UID начинают расти заново с низких чисел), текущий
ongoing-поиск `SEARCH uid:${last_seen_uid+1}:*` в `fetchNewMessages` вернёт
пусто (новая почта теперь на UID **ниже** устаревшего high-watermark). Результат:
R2 **тихо перестаёт принимать новую почту** для этого аккаунта, пока UID снова
не перерастут старый watermark — silent-blindness ровно того же класса, что мы
только что починили для Digital Observer'а в iter 1.5.

**Корень.** `fetchNewMessages` ищет только по числовому диапазону UID и не
сверяет `UIDVALIDITY`. Хуже того: если за время «слепоты» новая эпоха успела
дорасти UID выше старого watermark, поиск вернёт **частичный** срез
(high-UID-хвост новой эпохи) и навсегда пропустит всё, что ниже — то есть либо
тишина, либо частичный flood + потеря почты. Никаких логов/алертов.

**Фикс (observe + self-heal).** Хранить `UIDVALIDITY` рядом с `last_seen_uid`.
На каждом ongoing-тике, **до** fetch, читать текущий `UIDVALIDITY` мейлбокса
(imapflow отдаёт его на открытии: `client.mailbox.uidValidity`). Если он
отличается от сохранённого: понятный `[emails]`-warning + сброс watermark по той
же first-tick-стратегии «skip backlog, `last_seen_uid = current maxUid`» (чтобы
не перекраулить весь инбокс) + персист нового `UIDVALIDITY` + **однократный**
Discord-DM через существующий cognition-publish путь (как blind-alert
window-logger'а). Затем ongoing-путь снова работает штатно.

**Решения пользователя (зафиксированы до плана):**
- Проброс validity: **отдельный probe `getUidValidity(account)` в imap-client,
  читается в начале ongoing-тика ДО `fetchNewMessages`** (аддитивно: контракты
  `MessageFetcher`/`MaxUidProbe` не меняем; существующие fetch-тесты не трогаем).
  Цена — +1 лёгкий коннект на тик (только `mailboxOpen`, без `SEARCH`); при
  дефолтном `EMAIL_POLL_INTERVAL_MS=300_000` (5 мин) это незаметно. Проверка ДО
  фетча → мы никогда не действуем на данные чужой UID-эпохи.
- Alert path: **Log + однократный Discord** (не log-only).

## Context (from discovery)

**Файлы:**
- `packages/server/src/db.ts` — схема. `CREATE TABLE IF NOT EXISTS
  email_account_state (...)` на строках **208–215**; идемпотентные миграции через
  `PRAGMA table_info(...)` + `.some(c => c.name === ...)` + `ALTER TABLE ... ADD
  COLUMN` (пример `urgent_pinged_at` на `email_pending`, ~241–246).
- `packages/server/src/emails/store.ts` — `EmailStore` (интерфейс стр. 5–27,
  реализация 29–188). Upsert-паттерн в `updateLastSeenUid` (44–53) и
  `setAccountError` (54–62). Сюда — `getUidValidity` + `setLastSeenAndValidity`.
- `packages/server/src/emails/imap-client.ts` — `withClient` (70–86) уже делает
  `client.mailboxOpen('INBOX')`; `getMaxUid` (104–115) — точный шаблон для нового
  `getUidValidity`. `__setImapFlowCtor` (8–10) — точка мока.
- `packages/server/src/emails/multi-account-poller.ts` — `TickParams` (38–48),
  first-tick gate (191–207, **не трогаем**), ongoing-путь (209–246), per-account
  `try/catch` → `setAccountError` (247–250). Новая логика — между чтением
  `sinceUid` (209) и `fetcher(...)` (210).
- `packages/server/src/index.ts` — wiring `startEmailPoller` (605–638): сюда
  `validityProbe` + `onUidValidityReset`. Импорт imap-client на стр. **54**.
  Шаблон Discord-алерта — блок `onBlind` window-logger'а (804–819).
- Тесты: `packages/server/src/emails/__tests__/{store,imap-client,multi-account-poller}.test.ts`
  (vitest, `initDb(':memory:')`, `createEmailStore({ db: getDb() })`,
  `makeClientStub` + `__setImapFlowCtor`, моки `fetcher/scorer` через `vi.fn()`).
  Integration-шаблон — `packages/server/src/__tests__/window-logger.integration.test.ts`
  (реальный `EventEmitter` bus + `events.push`, «ровно один cognition_publish»).

**Паттерны для переиспользования:**
- Discord publish path — `reminderBus.emit('push', { type:'cognition_publish',
  runId:-1, handler, content })`; bot слушает в `channels/discord/bot.ts`
  (`cognitionListener`), DM'ит `💭 _from <handler>_\n<content>`.
- Sentinel `runId: -1` — poller не cognition handler, своей строки в
  `cognition_handler_runs` нет; `markPublished(-1)` → `UPDATE ... WHERE id=-1`
  (0 строк, безвредно). Тот же приём, что window-logger.
- first-tick-стратегия «skip backlog»: `maxUidProbe` → `last_seen_uid = maxUid`.

**Расхождение с window-logger (осознанное).** Смена `UIDVALIDITY` — **дискретное
редкое событие**, а не длящееся состояние (как «слепота» window-logger'а).
Поэтому НЕ нужны ни счётчик-порог, ни env-var `*_ALERT_AFTER`, ни флаг `alerted`:
один алерт на одно событие сброса возникает естественно — сразу после сброса мы
персистим новый `UIDVALIDITY`, и следующий тик видит `stored == current` → не
ре-алертит. Это проще шаблона.

**Без новых внешних зависимостей. Без нового env-var.**

## Development Approach

- **Testing approach: TDD** (падающий тест → реализация → зелёный, в каждой
  задаче).
- Каждая задача завершается полностью (все её тесты зелёные) до следующей.
- Малые сфокусированные изменения; прогон тестов после каждого.
- Обратная совместимость: для уже существующих аккаунтов (`uid_validity` = NULL
  после миграции) — backfill-ветка адоптирует текущий validity как baseline
  **без** сброса watermark (нет оснований считать, что он менялся). Никакого
  ре-краула.
- Scoped прогон: `npm -w @r2/server test -- <pattern>`.

## Testing Strategy

- **Unit** (`store.test.ts`, `imap-client.test.ts`, `multi-account-poller.test.ts`):
  in-memory store + моки imapflow/fetcher. Вся реальная логика
  detect/backfill/reset покрыта здесь.
- **Integration** (`packages/server/src/__tests__/email-poller.integration.test.ts`,
  новый): реальный `EventEmitter` bus; смена `UIDVALIDITY` → ровно один
  `cognition_publish` `handler='email-poller'`, watermark сброшен; повторный тик
  (validity совпал) → нового publish нет.
- index.ts-замыкание (точная строка warning/DM) — тонкий glue: проверяется
  чтением + integration-кейсом на форму события; brittle-тест на текст не пишем.
- Live-IMAP тестов нет (imapflow замокан за `__setImapFlowCtor`); реальная
  проверка смены `UIDVALIDITY` — в Post-Completion.

## Progress Tracking

- Отмечать `[x]` сразу по завершении пункта.
- ➕ — новые подзадачи, ⚠️ — блокеры.
- Держать план в синхроне с фактической работой.

## What Goes Where

- **Implementation Steps** (`[ ]`): код, тесты, docs.
- **Post-Completion** (без чекбоксов): ручная проверка на живом IMAP-аккаунте.

## Implementation Steps

### Task 1: Persistence — `uid_validity` column + store methods (TDD)

- [x] в `store.test.ts` написать падающие тесты:
  - **getUidValidity → null для неизвестного аккаунта** (нет строки).
  - **getUidValidity → null, когда строка есть, но validity не задан** (после
    одного `updateLastSeenUid`).
  - **setLastSeenAndValidity персистит оба поля**: после вызова
    `getLastSeenUid` и `getUidValidity` отражают записанные значения.
  - **setLastSeenAndValidity — upsert**: повторный вызов обновляет оба поля и
    обнуляет `last_error` (по аналогии с `updateLastSeenUid`).
- [x] в `db.ts` добавить идемпотентную миграцию `email_account_state` (зеркало
  паттерна `urgent_pinged_at`, ~241–246): `PRAGMA table_info(email_account_state)`
  → если нет `uid_validity` → `ALTER TABLE email_account_state ADD COLUMN
  uid_validity INTEGER` (nullable, без DEFAULT — NULL = «baseline неизвестен»).
  Если конвенция для `urgent_pinged_at` дублирует колонку и в `CREATE TABLE`
  (стр. 208–215) — добавить `uid_validity INTEGER` и туда (PRAGMA-guard делает
  ALTER no-op'ом на свежих БД).
- [x] в `store.ts` расширить `EmailStore` (интерфейс + реализация):
  - `getUidValidity(accountId: string): number | null` — `SELECT uid_validity
    FROM email_account_state WHERE account_id = ?`; `row?.uid_validity ?? null`.
  - `setLastSeenAndValidity(accountId: string, uid: number, uidValidity: number,
    now: number): void` — upsert `account_id, last_seen_uid, uid_validity,
    last_poll_at`, в `ON CONFLICT DO UPDATE` писать все три + `last_error = NULL`
    (точная форма как `updateLastSeenUid`, плюс колонка `uid_validity`).
- [x] прогнать `npm -w @r2/server test -- store` — зелёно до Task 2.

### Task 2: `getUidValidity` в imap-client (TDD)

- [ ] в `imap-client.test.ts` расширить `makeClientStub`: опция `uidValidity?:
  number | bigint`, выставляющая `this.mailbox = { uidValidity }` (доступно после
  `mailboxOpen`). Написать падающие тесты:
  - **возвращает `Number(client.mailbox.uidValidity)`** для заданного значения.
  - **коэрцит BigInt → number** (imapflow отдаёт `uidValidity` как BigInt;
    значение 32-битное по RFC 3501 → `Number()` точен).
  - **бросает, если `mailbox.uidValidity` отсутствует/undefined** (трактуем как
    probe-failure — пусть тик уйдёт в `setAccountError` и повторится).
  - **пробрасывает ошибку connect** (`throwOn: 'connect'`) — как у `getMaxUid`.
- [ ] в `imap-client.ts` добавить `export async function getUidValidity(account:
  ImapAccount): Promise<number>` через `withClient` (зеркало `getMaxUid`,
  104–115, с JSDoc в том же духе): прочитать `client.mailbox?.uidValidity`;
  если `== null` → `throw new Error('IMAP mailbox.uidValidity unavailable')`;
  иначе `return Number(v)`.
- [ ] прогнать `npm -w @r2/server test -- imap-client` — зелёно до Task 3.

### Task 3: Detect & self-heal `UIDVALIDITY` change в poller (TDD)

- [ ] в `multi-account-poller.test.ts` написать падающие тесты (новые опции
  `runPollTick`). Сначала **добавить `validityProbe` во ВСЕ существующие вызовы
  `runPollTick(...)`** (новое required-поле), напр.
  `validityProbe: vi.fn(async () => 1)` — иначе TS не соберётся; backfill-ветка
  прозрачна для их ассертов (пишет тот же `last_seen_uid`). Новые кейсы:
  - **validity unchanged → нормальный catch-up**: seed
    `setLastSeenAndValidity('a', 1, 111, t)`, `validityProbe → 111`, `fetcher`
    отдаёт msgs → штатный ингест, `last_seen_uid` растёт, `onUidValidityReset`
    НЕ вызван (регрессия: новая проверка не ломает happy-path).
  - **validity changed → reset, skip backlog, без ингеста, один алерт**: seed
    `setLastSeenAndValidity('a', 5000, 111, t)`, `validityProbe → 222`,
    `maxUidProbe → 7`, `fetcher = vi.fn()`. Ассерты: `fetcher` НЕ вызван (вышли
    до фетча); `getLastSeenUid('a') === 7`; `getUidValidity('a') === 222`;
    0 pending; `onUidValidityReset` вызван **1 раз** с `{ account:'a',
    previous:111, current:222 }`; `console.warn` со строкой `[emails]
    UIDVALIDITY` (spy).
  - **тик после reset → нормальный путь возобновлён**: stored теперь 222,
    `validityProbe → 222` → штатный fetch/ингест.
  - **backfill (uid_validity = NULL) → записать validity, без reset, fetch
    идёт**: seed `updateLastSeenUid('a', 1, t)` (validity NULL), `validityProbe →
    333`, `fetcher` отдаёт msgs → `getUidValidity('a') === 333`, `last_seen_uid`
    вырос **через fetch** (не reset), `onUidValidityReset` НЕ вызван, `fetcher`
    ВЫЗВАН.
  - **validityProbe throws → setAccountError, без reset, без fetch, ретрай**:
    `validityProbe` reject → пойман per-account `try/catch` → `getAccountError`
    задан; `last_seen_uid`/`uid_validity` без изменений; `onUidValidityReset` НЕ
    вызван.
  - **first-tick без изменений**: нет строки → `maxUidProbe` →
    `updateLastSeenUid` (uid_validity остаётся NULL), `validityProbe` НЕ вызван
    (выходим до ongoing-блока). Документирует: validity инициализируется на 2-м
    тике через backfill.
- [ ] в `multi-account-poller.ts` расширить типы/`TickParams`:
  - `export type ValidityProbe = (account: ImapAccount) => Promise<number>;`
  - `validityProbe: ValidityProbe;` (**required** — это core-механизм, как
    `provider` у window-logger; не делаем опциональным, чтобы не вернуть тихий
    silent-disable — ровно тот класс багов, что чиним).
  - `onUidValidityReset?: (info: { account: string; previous: number; current:
    number }) => void;` (**optional** — только алерт, как `onBlind`).
- [ ] реализовать в ongoing-пути, **между** `const sinceUid = ...getLastSeenUid`
  (стр. 209) и `const msgs = await params.fetcher(...)` (стр. 210):
  ```ts
  const storedValidity = params.store.getUidValidity(acc.id);
  const currentValidity = await params.validityProbe(acc);   // ДО fetch
  if (storedValidity == null) {
    // первый раз узнаём UIDVALIDITY (новый аккаунт на 2-м тике или аккаунт
    // старше этой колонки): адоптируем как baseline БЕЗ сброса watermark —
    // нет оснований считать, что он менялся.
    params.store.setLastSeenAndValidity(acc.id, sinceUid, currentValidity, params.now);
  } else if (currentValidity !== storedValidity) {
    // мейлбокс пересоздан: last_seen_uid — watermark мёртвой эпохи.
    // uid:${last_seen_uid+1}:* пропустит всю новую почту (она ниже) или
    // частично заберёт high-хвост и потеряет остальное. Сброс по first-tick:
    // skip backlog (last_seen_uid = current maxUid), персист новый validity.
    console.warn(
      `[emails] UIDVALIDITY changed for ${acc.id}: ${storedValidity} → ${currentValidity}; mailbox recreated, resetting last_seen_uid to current maxUid (skipping backlog).`,
    );
    const maxUid = await params.maxUidProbe(acc);
    params.store.setLastSeenAndValidity(acc.id, maxUid, currentValidity, params.now);
    params.onUidValidityReset?.({ account: acc.id, previous: storedValidity, current: currentValidity });
    return; // пропускаем ингест этого тика; следующий тик идёт штатно
  }
  ```
  (первый блок — fallthrough к существующему `const msgs = await ...fetcher`.)
- [ ] прогнать `npm -w @r2/server test -- multi-account-poller` — зелёно до Task 4.

### Task 4: Wiring в index.ts + integration-тест

- [ ] в `index.ts` (стр. 54) добавить `getUidValidity` в импорт из
  `./emails/imap-client.js`.
- [ ] в `startEmailPoller({...})` (605–638) добавить:
  - `validityProbe: getUidValidity,`
  - `onUidValidityReset: ({ account, previous, current }) => { ... }` — зеркало
    `onBlind` (804–819): `console.warn` + `reminderBus.emit('push', {
    type:'cognition_publish', runId:-1, handler:'email-poller', content:
    \`⚠️ [emails] UIDVALIDITY сброс для ${account}: ${previous} → ${current}. Ящик пересоздан провайдером — watermark сброшен на текущий maxUid (backlog пропущен), ингест продолжится со следующего нового письма.\` })` — с комментарием про sentinel `runId: -1`.
- [ ] создать `packages/server/src/__tests__/email-poller.integration.test.ts`
  (зеркало blind-кейса window-logger'а, 129–178):
  - реальный `EventEmitter` bus + `events.push`; real in-memory store
    (`initDb(':memory:')`, `createEmailStore({ db: getDb() })`).
  - seed аккаунт `setLastSeenAndValidity('a', 5000, 111, t)`.
  - `validityProbe = async () => 222` (сменился), `maxUidProbe = async () => 7`,
    `fetcher = async () => []`, `onUidValidityReset` замкнут на
    `bus.emit('push', { type:'cognition_publish', runId:-1, handler:'email-poller',
    content:\`reset ${info.account} ${info.previous}->${info.current}\` })`.
  - вызвать `runPollTick({...})` один раз → assert: ровно один event
    `type==='cognition_publish' && handler==='email-poller'`; `content` —
    непустая строка; `getLastSeenUid('a') === 7`; `getUidValidity('a') === 222`.
  - повторно `runPollTick` с `validityProbe = async () => 222` (совпал) →
    второго publish нет (всё ещё 1) — подтверждает «один алерт на событие».
- [ ] прогнать `npm -w @r2/server test -- "email-poller|multi-account-poller"` —
  unit + integration зелёные.

### Task 5: Документация + приёмка

- [ ] README (раздел про email watcher) + `AGENTS.md`: короткий блок про
  UIDVALIDITY self-heal — watcher хранит `UIDVALIDITY` рядом с `last_seen_uid`,
  на смене провайдером пересоздаёт baseline (skip backlog) и шлёт однократный
  `[emails]`-warning + Discord-DM. Явно отметить: **нового env-var нет**
  (событие дискретное, порог не нужен).
- [ ] приёмка:
  - все 4 цели из Overview реализованы (persist validity / detect+reset on tick /
    однократный Discord-алерт / тесты).
  - edge-cases покрыты: backfill, probe-failure, reset-затем-resume, first-tick.
  - `npm -w @r2/server test` — весь сервер-сьют зелёный.
  - build/type-check `npm run build -w @r2/server` (`tsc -b`) — exit 0 (ESLint в
    репо не настроен; tsc выступает type/lint-гейтом).

*Note: ralphex автоматически переносит завершённый план в `docs/plans/completed/`.*

## Technical Details

### Поток данных (ongoing-тик)

```
getLastSeenUid → sinceUid
getUidValidity → storedValidity (number | null)
validityProbe(acc) → currentValidity            // mailboxOpen, без SEARCH
  storedValidity == null      → setLastSeenAndValidity(sinceUid, current)  // backfill, идём дальше
  current !== stored          → warn + maxUidProbe + setLastSeenAndValidity(maxUid, current) + onUidValidityReset; return
  current === stored          → (ничего) → штатный fetcher(sinceUid) → score → insert → updateLastSeenUid
```

### Почему проверка ДО fetch, и почему reset = current maxUid

Опасный кейс: за «слепоту» новая эпоха доросла UID выше старого watermark.
`uid:${old+1}:*` тогда вернёт high-UID-хвост новой эпохи и **навсегда** пропустит
всё ниже. Проверяя validity **до** fetch и сбрасывая `last_seen_uid` на текущий
`maxUid` новой эпохи (skip backlog — как first-tick), мы не ингестим частичный
срез и не краулим весь пересозданный инбокс; новые письма идут со следующего тика.

### Backfill (NULL validity) ≠ reset

`getUidValidity` отдаёт `null` и для отсутствующей строки, и для `uid_validity IS
NULL`. NULL означает «baseline ещё не записан» (аккаунт старше колонки, либо
новый — на 2-м тике). Эта ветка лишь записывает текущий validity при неизменном
watermark — **никакого** сброса/алерта, fetch продолжается. Так одна ветка
инициализирует validity для всех аккаунтов; first-tick-путь (191–207) не трогаем.

### `validityProbe` required, `onUidValidityReset` optional

`validityProbe` — источник данных детекции (аналог `provider` у window-logger):
required, чтобы забытый wiring не вернул silent-blindness тихо. Существующие
poller-тесты добиваем этим полем механически. `onUidValidityReset` — только
алерт (аналог `onBlind`): optional.

### Sentinel runId: -1

`cognition_publish` ждёт `runId` строки `cognition_handler_runs`; у poller'а её
нет. `-1` безопасен: `markPublished(-1)` → 0 строк, `firePublished(-1)` → no-op.
DM рендерится как `💭 _from email-poller_\n<content>`. Минус: алерт не попадёт в
`cognition status` — приемлемо, warning-лог даёт observability.

### Тип `UIDVALIDITY`

imapflow отдаёт `mailbox.uidValidity` как BigInt; по RFC 3501 это 32-битное
unsigned → `Number()` точен и кладётся в SQLite-колонку `INTEGER` как обычное
число. `getUidValidity` бросает при отсутствии значения (probe-failure →
`setAccountError` → ретрай следующего тика).

## Post-Completion

*Без чекбоксов — нужен живой IMAP-аккаунт.*

- На аккаунте с воспроизводимой сменой `UIDVALIDITY` (или вручную через тестовый
  IMAP-сервер): после смены убедиться, что в логах есть `[emails] UIDVALIDITY
  changed for <acc>: <old> → <new>` и приходит **один** Discord-DM «UIDVALIDITY
  сброс».
- Подтвердить, что после сброса новая почта снова ингестится (следующий тик), а
  backlog новой эпохи не перекраулен (нет flood'а старых писем).
- Подтвердить отсутствие повторных DM на последующих тиках (один алерт на одно
  событие).
- (Оптимизация на будущее, вне scope) при росте числа аккаунтов/частоты опроса —
  объединить `validityProbe` и `fetchNewMessages` в один `withClient`-коннект.
