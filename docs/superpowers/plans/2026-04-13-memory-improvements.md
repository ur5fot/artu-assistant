# Memory System Improvements — importance, decay, UI, context window

## Overview

Покращення системи пам'яті за принципами людської пам'яті. Сім пов'язаних змін в одному плані:

1. **Context window на бекенді** — обрізати `messages[]` у чат-роуті до token-бюджету замість того щоб слати всю історію в модель.
2. **`/запам'ятай <текст>`** — slash-команда, що створює fact з `importance=10` (захищений від decay).
3. **Кейворд-детектор** — якщо user-повідомлення містить «важливо», «запам'ятай», «не забудь» → extractor виставляє `importance=10` для витягнутих фактів.
4. **Нормалізація ключів** — extractor видає факти у форматі `subject.attribute` (`user.wife`, `user.project.r2.phase`) замість довільних ключів, щоб легше було дедупити і шукати.
5. **UI-плашка «Згадав: …»** — SSE-подія `memory_recalled` + компонент над відповіддю, що показує retrieved facts з можливістю позначити застарілі.
6. **Дедуп при збереженні** — перед `INSERT` перевіряти `memory_facts` за `key`; якщо збіг — `superseded_by` старий + вставити новий, замість плодити дублікати.
7. **`/забудь <ключ або текст>`** — маркує fact як `forgotten=true` (raw log лишається). Плюс **decay** для importance<10: старі неактивні факти тонуть у ранжуванні.

**Проблема:** Зараз пам'ять — чорна скринька. Контекст роздувається лінійно від довжини сесії. Усі факти рівні за значимістю. Дублікати накопичуються. Юзер не знає що R2 «пам'ятає» і не може виправити.

**Очікуваний результат:** Детермінована, керована пам'ять з чесним ранжуванням, прозорим UI і явними командами.

## Context (from discovery)

**Files/components involved:**

- `packages/server/src/memory/db.ts` — схема `memory_facts` (колонки: `id, key, value, created_at, superseded_by, last_mentioned_at` — `importance` **відсутня**). Треба додати `importance INTEGER NOT NULL DEFAULT 1` і `forgotten INTEGER NOT NULL DEFAULT 0`.
- `packages/server/src/memory/extractor.ts:8-25` — український prompt для Ollama. Повертає `[{key, value}]` JSON. Треба розширити prompt щоб видавав `importance` і ключі у форматі `subject.attribute`.
- `packages/server/src/memory/service.ts:172-218` — `buildContextPrefix(userText)`. Зараз бере ВСІ активні факти (`slice(0, 20)`) + top-10 entries. Треба: ранжувати факти за `importance * freshness_decay`, фільтрувати `forgotten=0`, повертати метадані для SSE (щоб клієнт побачив що саме зачепили).
- `packages/server/src/routes/chat.ts:182-450` — **нема обрізання messages**. Треба додати token-budget truncation перед `runChatRequest`.
- `packages/tool-memory/src/index.ts` — існуючий `memory_search` tool. Додати два нових: `memory_remember` (slash `/запам'ятай`) і `memory_forget` (slash `/забудь`).
- `packages/shared/src/types.ts:70-80` — `SSEEvent` union. Додати `memory_recalled` подію (paralel `pii_masked`).
- `packages/client/src/components/` — новий компонент `MemoryRecalledCard.tsx` (або додати до `ToolCallCard.tsx`).
- `packages/client/src/hooks/useChat.ts` — обробка нової SSE-події.

**Related patterns found:**

- `pii_masked` SSE-подія — готовий зразок структури для `memory_recalled`.
- Slash-команди через `command:` поле у ToolDefinition, auto-discovery у registry — нічого ручного.
- `tool-prompt-overlay` (свіжо-мерджений) — референс для додавання нових tools з command-полем.
- `superseded_by` механізм уже працює — дедуп просто викликає його прицільно.

**Dependencies identified:** жодних нових npm-пакетів. Для token-підрахунку — використати простий eval `content.length / 4` (приблизно) або `tiktoken`, якщо є в node_modules; перевірити.

## Development Approach

- **Testing approach:** Regular (code first, then tests). Архітектура і файли відомі.
- Задачі виконуються послідовно, кожна з тестами, усі тести зелені перед наступною задачею.
- Міграція schema: `ALTER TABLE memory_facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 1` + `forgotten INTEGER NOT NULL DEFAULT 0`. SQLite дозволяє.
- Backward compat: існуючі факти отримують `importance=1, forgotten=0` — decay м'який, вони не зникнуть одразу.

## Testing Strategy

- **Unit**: кожна задача — додаткові тести в `packages/server/src/memory/__tests__/*.test.ts` і `packages/tool-memory/__tests__/*.test.ts`.
- **Integration**: `packages/server/src/routes/__tests__/chat.test.ts` — нова перевірка що history truncate працює і `memory_recalled` event емітиться.
- **E2E**: не застосовно (нема Playwright).

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add ➕ for newly discovered tasks
- Mark blockers with ⚠️

## Implementation Steps

### Task 1: Schema — importance і forgotten колонки

- [x] у `packages/server/src/memory/db.ts` у `initDb()` (або `migrateMemorySchema()`) додати `ALTER TABLE memory_facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 1` з `IF NOT EXISTS`-патерном (SQLite: спробувати ALTER в try/catch, бо IF NOT EXISTS на колонках не підтримується)
- [x] те саме для `forgotten INTEGER NOT NULL DEFAULT 0`
- [x] оновити `insertFact` / `updateFact` / `searchFacts` запити щоб читали і писали нові колонки
- [x] додати `markFactForgotten(factId)` хелпер — `UPDATE memory_facts SET forgotten = 1 WHERE id = ?`
- [x] оновити `SELECT ... FROM memory_facts` у `listActiveFacts` (і всюди) щоб фільтрувало `forgotten = 0`
- [x] тести у `memory/__tests__/db.test.ts` — insert з importance, update importance, markForgotten, forgotten факти не з'являються в list
- [x] `npm --workspace @r2/server test`

### Task 2: Дедуп при збереженні (superseded_by)

- [x] у `packages/server/src/memory/service.ts` (або `db.ts`, де написана логіка збереження fact) перед `INSERT` перевіряти `SELECT id FROM memory_facts WHERE key = ? AND superseded_by IS NULL AND forgotten = 0`
- [x] якщо є — `UPDATE memory_facts SET superseded_by = ? WHERE id = <old>` де `?` — id нового rowу
- [x] переконатися що importance успадковується: `new.importance = MAX(new.importance, old.importance)` (не втрачати user-помічені факти при автоперезапису)
- [x] тести: save same-key двічі → старий superseded, новий активний; importance не знижується; різні ключі живуть незалежно
- [x] `npm test`

### Task 3: Slash `/запам'ятай` — memory_remember tool

- [ ] створити `packages/tool-memory/src/memory-remember.ts` (або додати до `index.ts` як другий tool)
- [ ] `ToolDefinition`: `name: 'memory_remember'`, `command: { name: 'запам'ятай', description, params: [{name:'text', required:true}] }`, `permissionLevel: 'auto'`, `provider: 'all'`
- [ ] handler: парсить `text`, витягує (LLM extractor з importance=10, або простіша логіка — ввесь текст як один fact `user.note.<timestamp> = <text>`)
- [ ] рішення: для MVP — найпростіше, весь текст у fact `user.note.<random-id>` з importance=10. Якщо юзер хоче структурно — пише явно «ключ: значення».
- [ ] детектор `key: value` синтаксису у тексті — якщо є двокрапка, розділити на key і value.
- [ ] реєстрація у `packages/server/src/tools/registry.ts` відбувається auto-discovery
- [ ] тести у `packages/tool-memory/__tests__/remember.test.ts`: простий текст → fact з importance=10, `key: value` → parsed, empty → error
- [ ] `npm test`

### Task 4: Кейворд-детектор у extractor

- [ ] у `packages/server/src/memory/extractor.ts` у функції, що викликає LLM, перед викликом зробити простий regex-скан тексту на `/(важливо|запам'ятай|запомни|не забудь|don't forget|important)/i`
- [ ] якщо match — після отримання LLM-відповіді підняти `importance` усіх витягнутих фактів з 1 до 10 (або додати prompt-інструкцію щоб LLM робив це сам, але regex надійніше)
- [ ] тести: текст без кейвордів → importance=1, з кейвордом → importance=10, case-insensitive, не хапає «важливоість» як substring (word boundary)
- [ ] `npm test`

### Task 5: Нормалізація ключів у форматі subject.attribute

- [ ] оновити LLM-prompt в `extractor.ts` — додати приклади і вимогу: «ключ має формат `subject.attribute`, де subject = `user`, `project`, `assistant` etc, attribute — snake_case»
- [ ] додати post-validation: якщо LLM повернув ключ без крапки → додати префікс `user.` за замовчуванням
- [ ] також — lowercase і replace spaces → `_`
- [ ] тести у `memory/__tests__/extractor.test.ts` — перевірити що prompt включає правило, mock LLM returns різні формати → всі нормалізуються
- [ ] `npm test`

### Task 6: Ранжування у buildContextPrefix з importance + decay

- [ ] у `packages/server/src/memory/service.ts:172-218` змінити fact retrieval:
  - замість `slice(0, 20)` — запит з `ORDER BY (importance * exp(-(now - last_mentioned_at) / halflife))`
  - halflife — константа `IMPORTANCE_HALFLIFE_MS = 30 * 24 * 3600 * 1000` (30 днів)
  - `importance=10` факти не тонуть бо множник великий
  - SQLite не має `exp()` — або зробити на JS боці після SELECT, або спростити: `WHERE importance >= 5 OR last_mentioned_at > (now - 30d)`
- [ ] при кожному використанні fact у context prefix — оновлювати `last_mentioned_at = Date.now()` (reconsolidation effect)
- [ ] повертати з buildContextPrefix не тільки текст, а й **метадані про використані факти**: `{ prefix: string, recalledFacts: Array<{key, value, importance}> }` — для SSE
- [ ] оновити виклики (router.ts, chat.ts) на новий тип повернення
- [ ] тести: high-importance факт виринає; старий low-importance — ні; mention оновлює last_mentioned_at
- [ ] `npm test`

### Task 7: Slash `/забудь` — memory_forget tool

- [ ] додати `memory_forget` tool з `command: { name: 'забудь', params: [{name:'query', required:true}] }`
- [ ] handler: шукає factId за key (точний збіг) або через vector search; маркує `forgotten=1` через `markFactForgotten`
- [ ] якщо знайдено кілька — повертає список і просить уточнити (у відповіді)
- [ ] тести: точний ключ → помічено; нема збігу → error; forgotten fact більше не в search
- [ ] `npm test`

### Task 8: SSE-подія memory_recalled і UI

- [ ] у `packages/shared/src/types.ts:70-80` додати до union `SSEEvent`:
  ```ts
  | { type: 'memory_recalled'; facts: Array<{ key: string; value: string; importance: number }> }
  ```
- [ ] у `router.ts` (або chat.ts, там де викликається `buildContextPrefix`) — одразу після отримання prefix емітити `memory_recalled` event з `recalledFacts`
- [ ] у клієнті `packages/client/src/hooks/useChat.ts` — обробити нову подію, зберігати у state поряд з повідомленнями
- [ ] створити `packages/client/src/components/MemoryRecalledCard.tsx` — маленька плашка «🧠 Згадав: user.wife=Марина, …» над або під відповіддю, з кнопкою 🗑 біля кожного факту (натискання → надіслати `/забудь user.wife`)
- [ ] інтегрувати в `Chat.tsx` рендер
- [ ] тести backend: емітиться при buildContextPrefix з фактами, не емітиться коли пусто
- [ ] unit-тест компоненту (якщо є setup для client-тестів; якщо ні — візуальна перевірка)

### Task 9: Context window truncation у chat.ts

- [ ] у `packages/server/src/routes/chat.ts` перед `runChatRequest` (~ line 331) додати функцію `truncateMessages(messages, maxChars)` яка:
  - завжди лишає SYSTEM (якщо є) + останнє user повідомлення
  - від кінця до початку додає повідомлення поки сумарно ≤ `maxChars`
  - відкинуті — просто не передаються (raw лишаються в БД для історії)
- [ ] `maxChars` конфігурується через `process.env.CHAT_CONTEXT_BUDGET_CHARS` (default 60000 ≈ 15k tokens — комфортно для Haiku/qwen)
- [ ] тести: коротка сесія — всі повідомлення; довга — обрізається; порядок і цілісність пари user/assistant зберігається (не обрізати assistant без його user)
- [ ] `npm test`

### Task 10: Verify acceptance criteria

- [ ] запустити повний `npm test` — всі тести зелені
- [ ] typecheck усіх workspaces
- [ ] ручна перевірка (опціонально): живий чат, сказати «запам'ятай що мене звати Іван» → `/запам'ятай` fact importance=10 у БД; наступне питання «як мене звати» → у відповіді використано fact, у UI плашка «Згадав: user.name=Іван»; `/забудь user.name` → наступне питання не знає імені
- [ ] перевірити що існуючі 398+ тестів не зламалися

### Task 11: [Final] Оновити документацію

- [ ] оновити `AGENTS.md` з новими slash-командами (`/запам'ятай`, `/забудь`) і поясненням importance/decay
- [ ] оновити `.env.example` — додати `CHAT_CONTEXT_BUDGET_CHARS=60000`

## Technical Details

**Schema migration (additive, безпечно):**
```sql
ALTER TABLE memory_facts ADD COLUMN importance INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memory_facts ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0;
```
Міграція — через try/catch (SQLite не підтримує IF NOT EXISTS для колонок).

**Importance levels:**
- `1` — автоекстрактор, дефолт
- `3-5` — (reserved, майбутнє, наразі не виставляється)
- `10` — явна команда `/запам'ятай` або кейворд в тексті. Не тоне у decay.

**Decay формула (JS-бік):**
```ts
const HALFLIFE_MS = 30 * 24 * 3600 * 1000;
const score = importance * Math.exp(-ageMs / HALFLIFE_MS);
```
Факти з `score < 0.1` не включаються у context prefix (але лишаються в БД).

**Token budget** — приблизно `chars / 4`, тому `CHAT_CONTEXT_BUDGET_CHARS=60000` ≈ 15k tokens. Достатньо для hаiku і qwen2.5.

## Post-Completion

**Manual verification:**
- Довгий чат — переконатися що після ~50 повідомлень контекст не роздувається, перевірити через `[ollama raw response]` логи.
- Importance=10 facts не зникають після 31 дня (decay в дії).
- UI-плашка з'являється коли є згадка, зникає коли нема.

**Out of scope:**
- Графовий expansion
- Нічна консолідація (cron job)
- Working memory окрема таблиця
- Автосумаризація старих повідомлень
- Multi-session іменовані пам'яті
