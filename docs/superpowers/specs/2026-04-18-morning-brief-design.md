# Morning Brief — first real cognition handler

## Problem

После мерджа cognition layer (2026-04-18) heartbeat-инфра работает, но единственный зарегистрированный handler — `pulse` — демо, не приносит ценности (всегда `skip`). Нужен первый «настоящий» handler, который доказывает цепочку tick → trigger → run → publish → Discord DM на реальном use-case и задаёт паттерн для будущих handler'ов (evening reflection, open-loop detector, conversation optimizer — см. `project_roadmap.md`).

Morning brief — утренняя сводка. При первом сообщении юзера за день после 06:00, Claude собирает данные (reminders, memory, recent chat context), анализирует и возвращает brief с конкретными предложениями действий на день. Smart-on-activity trigger — не будит юзера, но срабатывает сразу когда он проснулся.

## Goals

1. Новый handler `morningBrief` рядом с `pulse`.
2. Fires ровно один раз в локальный день, привязан к первой активности юзера.
3. Данные собираются из существующих таблиц (reminders, memory_entries, memory_facts, chat_messages) — без новых интеграций.
4. LLM вызов использует существующий AI слой (`CLAUDE_MODEL`, `ANTHROPIC_API_KEY`, `LOCAL_LLM_MODE` из `.env`) и проходит через PII proxy как обычные chat-сообщения.
5. Результат публикуется всем юзерам в whitelist через существующий `cognition_publish` канал (без изменений `HandlerResult`).

## Non-goals

- Google Calendar / Gmail integration (отдельный трек).
- Interactive buttons (Accept / Reschedule) — v2.
- Per-user targeting (`targetUserId` в `HandlerResult`) — пока shared с общим pulse-каналом.
- Reply handling — юзер может ответить в DM, попадёт в обычный chat pipeline (работает бесплатно).
- Retry policy — если Claude недоступен, handler возвращает `error` и завтра попробует снова; в пределах одного дня не retry.
- Настройка времени / содержания через чат — фиксированные константы в коде.

## Architecture

### Trigger

```ts
trigger(state: HandlerState): boolean {
  const tz = 'Europe/Kyiv'; // single swap-point
  const nowLocal = toLocal(state.now, tz);
  if (nowLocal.hour < 6) return false;
  if (state.lastFiredAt && isSameLocalDate(state.lastFiredAt, state.now, tz)) return false;
  return hasUserActivityToday(db, tz);
}
```

`hasUserActivityToday` — pure query helper:

```sql
SELECT 1 FROM chat_messages
WHERE created_at > :todayStartLocal
LIMIT 1
```

Trigger читает `db`. Текущая сигнатура `Handler.trigger` принимает только `HandlerState`, не `HandlerContext` — поэтому **расширяем** сигнатуру:

```ts
trigger: (state: HandlerState, ctx: HandlerContext) => boolean | Promise<boolean>;
```

Dispatcher обновляется передавать `ctx` (у него уже есть `db` и `signal`). Существующий `pulse.trigger` игнорирует второй аргумент — совместимо. `queue.ts` и `dispatcher.ts` тесты обновляются.

### Run

```ts
async run(ctx: HandlerContext): Promise<HandlerResult> {
  const data = gatherData(ctx.db);              // pure, testable
  const prompt = composePrompt(data);            // pure, snapshot-testable
  const response = await callAI(prompt, ctx.signal); // через существующий AI слой
  if (!response.trim()) return { skip: true, reason: 'empty response' };
  return { publish: true, content: response };
}
```

### Data gathering (`gatherData`)

```ts
interface BriefData {
  reminders: Array<{ text: string; nextFireAt: number }>; // active=1 AND next_fire_at_ms BETWEEN today_start AND tomorrow_end
  notes: Array<{ key: string; value: string; lastMentionedAt: number }>; // memory_facts WHERE superseded_by IS NULL AND last_mentioned_at > now-14d; relevant keys — конкретный набор выбирается в plan'е при тюнинге prompt'а
  recentContext: Array<{ role: string; content: string; ts: number }>; // chat_messages last 48h, max 30 rows, content truncated to 500 chars
}
```

Все запросы — prepared statements, readonly. Limit на recent context — 30 rows + truncation каждого content до 500 chars чтобы prompt не раздувался.

### Prompt composition (`composePrompt`)

Шаблон:

```
Собери утренний brief для dim (русский язык).

## Reminders на сегодня/завтра
{list or "нет"}

## Открытые заметки (memory)
{list or "нет"}

## Recent context (последние 48h)
{list or "нет"}

Формат: 5-8 bullet points. Включи: (1) что конкретно на сегодня,
(2) открытые темы которые висят, (3) конкретные предложения действий.
Коротко. Не повторяй данные дословно — анализируй.
```

Temperature 0.5. System message: `Ты — R2, персональный ассистент dim. Язык — русский.`

### AI call

Используем существующий AI слой — тот же, что обслуживает обычные чат-сообщения. Вызов минимальный (одно `user` сообщение, без tool-use), но проходит через:
- PII proxy (anonymize → Anthropic → detokenize) — те же `pii_tokens`
- `LOCAL_LLM_MODE` router — если enabled, сначала ollama, escalate на Claude по стандартной логике

Код handler'а дёргает существующий `generateCompletion` / эквивалент (точная функция — определяется при реализации; ссылка в plan'е, не в spec'е). `AbortSignal` из `HandlerContext` передаётся.

### Output

`{ publish: true, content: <aiResponse> }` → `queue.ts` эмитит `cognition_publish` → `bot.ts` listener шлёт DM всем в whitelist. Существующий тракт, zero изменений.

### Configuration

**Env vars — используем существующие**, новых не добавляем:
- `CLAUDE_MODEL`, `ANTHROPIC_API_KEY`, `CLAUDE_MAX_TOKENS` — AI
- `LOCAL_LLM_MODE`, `OLLAMA_*` — router override

**Constants в коде** (все в `morningBrief.ts`):
- `TIMEZONE = 'Europe/Kyiv'`
- `ACTIVITY_START_HOUR = 6`
- `RECENT_CONTEXT_HOURS = 48`, `RECENT_CONTEXT_MAX_ROWS = 30`, `CONTENT_TRUNCATE_CHARS = 500`
- `NOTE_FRESHNESS_DAYS = 14`

Все в одном месте, правим при необходимости.

## Module layout

```
packages/server/src/cognition/handlers/
  morningBrief.ts                       # exports handler
  morningBrief.helpers.ts                # gatherData, composePrompt, hasUserActivityToday, date utils
  __tests__/
    morningBrief.helpers.test.ts         # trigger edge cases, prompt snapshot, data queries
    morningBrief.test.ts                 # handler shape + run wires helpers + AI call
```

Type signature расширяется:

```ts
// types.ts
export interface Handler {
  name: string;
  trigger: (state: HandlerState, ctx: HandlerContext) => boolean | Promise<boolean>;
  run: (ctx: HandlerContext) => Promise<HandlerResult>;
}
```

`dispatcher.ts` обновляется — передаёт `ctx` в `trigger`. Async triggers поддерживаются (await). Existing `pulse` trigger продолжает работать (игнорирует второй аргумент).

## Data flow

1. Heartbeat tick (каждые 60s) → dispatcher.runTick.
2. Dispatcher цикл: для каждого handler — `await trigger(state, ctx)`.
3. `morningBrief.trigger`: `now.hour >= 6` AND `lastFiredAt` не сегодня AND `chat_messages` есть сегодня → true.
4. Dispatcher enqueue'ит handler → worker `run`.
5. `gatherData` → `composePrompt` → AI call (~2-5s) → text.
6. Handler возвращает `publish: true`.
7. Queue записывает `cognition_handler_runs` (outcome='publish', content=text) и эмитит `cognition_publish` на bus.
8. Bot listener получает event → `dm.send(content)` каждому whitelisted user.
9. `markPublished` зовётся один раз после успешной доставки хотя бы одному.

## Error handling

- Claude API down / timeout (signal abort) → handler ловит, возвращает `{ error: true, message }`. Queue записывает outcome='error', DM не шлётся, `lastFiredAt` не меняется. Следующий tick через 60s снова проверит trigger — если сегодня уже день, попробует ещё раз. Защита от «шторма» — если три попытки подряд за час fail'ятся, trigger помечается как уже fired на сегодня (deferred — через поле в `cognition_state` или таблицу backoff — см. open point ниже).
- Пустой ответ от AI → `skip: true`, завтра попробует.
- DB locked / query error → исключение в trigger, ловится в dispatcher (уже есть try/catch), handler пропускается на этом тике.

## Testing

**Unit (helpers):**
- `hasUserActivityToday`: empty chat → false; message вчера (local) → false; message сегодня 01:00 local → true; timezone boundary (сообщение в 23:30 другого дня) — не считается «сегодня».
- `isSameLocalDate`: handles DST transitions (Kyiv has DST); midnight edge.
- `gatherData`: возвращает reminders в окне today+tomorrow; notes свежее 14 дней; chat_messages последние 48h, max 30 rows.
- `composePrompt`: snapshot с фиксированным набором данных; handles empty sections (показывает «нет»); truncation content >500 chars.

**Handler (`morningBrief.test.ts`):**
- trigger: basic flow (no activity → false; activity + not fired → true; fired today → false).
- run: mocks AI client; verifies `gatherData` called, prompt composed, result wrapped as `publish`.
- run error: AI throws → returns `error`.
- run empty: AI returns `''` → returns `skip`.

**Integration:**
- Покрыто существующими queue/dispatcher тестами (trigger теперь async — проверить что `await` работает).

## Open points / deferred

- **Backoff после повторных ошибок** — если Claude недоступен весь день, handler будет дёргать API каждый tick. Мягкое решение: после 3 error за 1 час — «как если бы fired», skip до завтра. Реализация: проверять `recentRuns` в trigger. Простое, не требует новых таблиц. Включим в plan как оптимизацию, не в MVP.
- **Persist trigger-suppress state** — сейчас lastFiredAt хранится в `cognition_handler_runs`. Этого достаточно. Если backoff понадобится — reuse same table.
- **Timezone как env var** — сейчас хардкод `Europe/Kyiv`. Вынести в env если юзер переедет.
- **Interactive replies** — если юзер ответит в DM, попадёт в обычный chat pipeline (работает сейчас). Кнопки «принято / перенеси» — v2.

## Risks

- **Prompt drift** — модель может писать banal brief'ы. Мониторим через `/heartbeat status` (видны последние runs с content). Корректируем prompt при необходимости — это просто константа.
- **Стоимость** — один вызов Claude Sonnet в день — копейки. Если `LOCAL_LLM_MODE=enabled`, вообще бесплатно.
- **Privacy** — PII proxy обрабатывает данные так же как обычные сообщения; risk не выше чем в chat pipeline.
- **Trigger сигнатура breaking change** — `trigger(state, ctx)` требует обновить `pulse` и его тесты (минимальный diff: добавить неиспользуемый параметр) + `dispatcher` + `dispatcher.test.ts`. Оценено — малый scope.

---

## Execution Status (2026-04-18)

**Automated verification — PASSED.** 502/502 vitest tests green, `tsc --noEmit` exit 0.

**Manual Discord E2E — PASSED.**
- `/heartbeat status` показывает `Registered handlers: pulse, morningBrief`.
- При первом сообщении дня в DM — brief приходит в пределах одного heartbeat tick, с осмысленным анализом: reminders на день, открытые заметки из memory (`user.note.*`, `user.activity`), рекомендации действий, честное признание отсутствия web-tool (вместо галлюцинации погоды).
- Язык вывода — русский, тон — дружелюбный-функциональный.
- Повторное сообщение в тот же день — brief не дублируется.
- Persist lastFiredAt через рестарт сервера подтверждён.
