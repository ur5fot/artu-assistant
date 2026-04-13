# Prompt Overlays — редагування надстройки промпту з чату

## Overview

Реалізація згідно зі спекою `docs/superpowers/specs/2026-04-13-prompt-overlays-design.md`. Дати юзеру можливість додавати власні інструкції поверх базового системного промпту для Claude та Ollama прямо з чату, через slash-команди `/клод-промпт` і `/лама-промпт`. Базовий промпт лишається захардкоджений — з чату керується тільки надстройка. Зміни зберігаються у SQLite і діють одразу у наступному запиті без рестарту сервера.

**Проблема, яку вирішує:** Зараз щоб додати правило у системний промпт потрібно редагувати `packages/server/src/ai/prompts.ts` і рестартити сервер. Юзер хоче on-the-fly керування — наприклад, «будь коротший», «відповідай англійською», «не використовуй emoji».

## Context (from discovery)

**Files/components involved:**
- `packages/server/src/db.ts` — SQLite bootstrap + існуючі хелпери таблиць (`memory_entries`, `memory_facts`, `permission_rules`, `audit_log` тощо). Паттерн: module-level singleton `db`, функції викликають `getDb()`, далі `db.prepare(sql).run(...)`.
- `packages/server/src/ai/prompts.ts` — `getSystemPrompt()` для Claude і `getLocalSystemPrompt(toolSummary)` для Ollama. Обидва повертають конкатеновану строку на основі `BASE_RULES`.
- `packages/server/src/tools/registry.ts` — auto-discovery тулів з `packages/tool-*/`.
- `packages/tool-web-search/src/index.ts` — reference-приклад тулу з полем `command: { name, description, params }` для slash-команди.
- `packages/server/src/routes/chat.ts` — парсить slash-команди і викликає відповідний tool handler (треба перевірити чи команди вже обробляються централізовано, чи додавати до існуючого map).

**Related patterns found:**
- Tool-export: plain object з полями `name`, `description`, `permissionLevel`, `provider`, `parameters`, `handler`, `command?`.
- DB queries: `better-sqlite3` sync API, prepared statements, без ORM.
- Slash-команди: вже існує `/пошук` у `web_search`, `/пам'ять` у `memory_search` тощо — ту саму шину використовуємо.

**Dependencies identified:**
- `better-sqlite3` (вже в `packages/server`)
- `@r2/shared` для типу `ToolDefinition`
- Реалізація зачіпає два існуючі файли (`db.ts`, `prompts.ts`) + один новий пакет

## Development Approach

- **Testing approach:** Regular (code first, then tests). Спека і паттерни чіткі, TDD не дасть додаткової користі.
- Кожна задача робиться повністю перед переходом до наступної.
- Малі, сфокусовані зміни.
- **КРИТИЧНО: кожна задача МУСИТЬ мати нові/оновлені тести** для змін у цій задачі.
- **КРИТИЧНО: всі тести мають проходити до початку наступної задачі** — без винятків.
- Запуск `npm test` після кожної задачі.
- Зворотня сумісність: базовий промпт не змінюється, overlay додається тільки коли є.

## Testing Strategy

- **Unit tests**: обов'язково для кожної задачі.
  - `db.test.ts` — get/set/clear overlay, INSERT OR REPLACE поведінка, clear на відсутньому ключі.
  - `prompts.test.ts` — overlay конкатенується коли є, не додається коли нема/порожній, правильні роздільники.
  - `tool-prompt-overlay/__tests__/` — handler з кожним з 6 варіантів вводу (див. таблицю у спеці).
- **Integration test**: `chat.test.ts` (або новий) — повний flow: `/клод-промпт тест` → overlay у БД → `getSystemPrompt()` містить «тест» → `/клод-промпт --скинути` → overlay видалено → `/клод-промпт --показати` повертає поточне значення.
- **E2E**: проєкт не має UI-based e2e (Playwright/Cypress), тому не застосовно.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: SQLite таблиця і функції overlay

- [x] додати в `packages/server/src/db.ts` у `initDb()` виклик `db.exec()` з `CREATE TABLE IF NOT EXISTS prompt_overlays (model TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at INTEGER NOT NULL)`
- [x] додати експортовану функцію `getOverlay(model: 'claude' | 'ollama'): string | null` — `SELECT text FROM prompt_overlays WHERE model = ?`
- [x] додати `setOverlay(model: 'claude' | 'ollama', text: string): void` — `INSERT OR REPLACE INTO prompt_overlays (model, text, updated_at) VALUES (?, ?, ?)` з `Date.now()`
- [x] додати `clearOverlay(model: 'claude' | 'ollama'): void` — `DELETE FROM prompt_overlays WHERE model = ?`
- [x] ліміт валідації: у `setOverlay` кидати помилку якщо `text.length > 10000` (повідомлення «prompt overlay too long (max 10000 chars)»)
- [x] написати тести у `packages/server/src/__tests__/db.test.ts` (або новий файл) — set→get повертає текст, INSERT OR REPLACE оновлює, clear видаляє, clear на відсутньому ключі не падає, set > 10000 кидає
- [x] `npm --workspace @r2/server test` — мають пройти всі тести

### Task 2: Конкатенація overlay у системні промпти

- [x] у `packages/server/src/ai/prompts.ts` імпортувати `getOverlay` з `../db.js`
- [x] у `getSystemPrompt()` після збирання базового тексту перевірити `const overlay = getOverlay('claude')`; якщо не `null` і не порожній після `.trim()` — додати `\n\n## Додаткові інструкції\n${overlay}`
- [x] те саме у `getLocalSystemPrompt(toolSummary)` для `getOverlay('ollama')`
- [x] написати тести у `packages/server/src/ai/__tests__/prompts.test.ts` (створити якщо нема): mock `getOverlay`, перевірити що з non-empty overlay у результаті є «Додаткові інструкції» і текст; з `null` або `''` — блок відсутній; базові правила не змінилися
- [x] `npm --workspace @r2/server test`

### Task 3: Новий пакет @r2/tool-prompt-overlay

- [x] створити `packages/tool-prompt-overlay/package.json` за зразком `packages/tool-web-search/package.json`, name `@r2/tool-prompt-overlay`
- [x] створити `packages/tool-prompt-overlay/tsconfig.json` за зразком сусідніх
- [x] створити `packages/tool-prompt-overlay/src/index.ts`:
  - фабрика `createTool(deps)` повертає **масив** з двох `ToolDefinition`: `prompt_overlay_claude` і `prompt_overlay_ollama` (обидва шарять один handler, різниця — параметр `model`)
  - кожен має `command: { name: 'клод-промпт' | 'лама-промпт', description, params: [{name:'text', required:false}] }`
  - параметри схеми: `{ text?: string, show?: boolean, reset?: boolean }`
  - `permissionLevel: 'confirm'` (side-effect на БД)
  - `provider: 'all'`
- [x] handler-логіка (згідно з таблицею у спеці):
  - `show=true` + `reset=true` → error «не можна поєднувати `--показати` і `--скинути`»
  - `show=true` + `text` → error «не можна поєднувати `--показати` з текстом»
  - `reset=true` + `text` → error «не можна поєднувати `--скинути` з текстом»
  - `show=true` → `getOverlay(model)`, повернути текст або `"порожньо"`
  - `reset=true` → `clearOverlay(model)`, повернути `"скинуто"`
  - `text` присутній → `setOverlay(model, text)`, повернути `"збережено"`
  - нічого не задано → error з usage-підказкою
- [x] додати `@r2/tool-prompt-overlay` у `packages/server/package.json` dependencies (`file:../tool-prompt-overlay`)
- [x] написати тести `packages/tool-prompt-overlay/__tests__/index.test.ts` — кожен з 6+ сценаріїв (set/get/reset/combinations/empty), mock db-функцій або in-memory SQLite
- [x] `npm --workspace @r2/tool-prompt-overlay test` і повний `npm test`

### Task 4: Інтеграція slash-команд у chat route

- [ ] перевірити у `packages/server/src/routes/chat.ts` як парсяться існуючі slash-команди (`/пошук`, `/пам'ять`); переконатися що auto-discovery через registry працює для нових tools без ручного hardcoding
- [ ] якщо є центральний парсер аргументів — переконатися що прапорці `--показати`, `--скинути` з кирилиці розпарсяться; якщо ні — адаптувати parsing (можливо trivial, можливо треба додати alias mapping)
- [ ] додати integration-тест у `packages/server/src/routes/__tests__/chat.test.ts`: `POST /chat` з `/клод-промпт тест` → в БД є overlay → наступний `getSystemPrompt()` містить «тест»; `/клод-промпт --скинути` → немає
- [ ] `npm --workspace @r2/server test`

### Task 5: Verify acceptance criteria

- [ ] перевірити що всі вимоги зі спеки реалізовані (get/set/clear, ліміт 10k, роздільники, помилки комбінацій)
- [ ] `npm run typecheck` (якщо є в скриптах) або `tsc --noEmit` для `@r2/server` і нового пакету
- [ ] `npm test` — повний test suite зелений
- [ ] ручний тест локально (опціонально, але бажано): `OLLAMA_DEBUG=1 npm run dev`, у чаті `/клод-промпт відповідай коротко`, наступний запит до Claude → у логах видно що overlay у system message

### Task 6: [Final] Оновити документацію

- [ ] додати коротку секцію у `AGENTS.md` про slash-команди `/клод-промпт`, `/лама-промпт` — usage, прапорці, ліміт
- [ ] якщо спека `docs/superpowers/specs/2026-04-13-prompt-overlays-design.md` містить щось що змінилося під час реалізації — додати примітку внизу «Реалізовано з відхиленнями: …»

## Technical Details

**Data:**
- Таблиця `prompt_overlays`: PK `model` (одна строка на модель, два максимум).
- Overlay зберігається as-is, без форматування.
- Ліміт 10 000 символів перевіряється у `setOverlay`, не у handler — захист навіть якщо tool обійдуть.

**Concatenation format:**
```
<base prompt>

## Додаткові інструкції
<overlay text>
```

Два переноси перед заголовком, один після.

**Slash-command argument parsing:**
Treating `--показати` і `--скинути` як boolean прапорці. Весь інший текст — позиційний `text`. Якщо чат-парсер використовує простий split на перше слово — треба переконатися що прапорці відсікаються перед тим як решта йде в `text`.

## Post-Completion

**Manual verification:**
- У живому UI: `/клод-промпт відповідай одним реченням` → наступна Claude-відповідь дійсно коротка.
- Рестарт сервера → `/клод-промпт --показати` повертає збережене значення (персистентність).
- `/лама-промпт` незалежно від `/клод-промпт` (окремі записи у БД).

**Out of scope (explicit non-goals з спеки):**
- Кілька іменованих пресетів
- UI-редактор
- Natural-language роутинг («поміняй промпт на …»)
- Версіонування / історія
