# Morning Brief: tool-loop + language fix

## Overview

`callMorningBriefAI` сейчас шлёт prompt в Claude **без tools**. Когда в brief нужна погода — LLM честно пишет "не могу дать прогноз, нужен поиск". User screenshot 2026-04-20: brief просит юзера "открой сам или разреши мне".

Плюс mix языков: входные данные содержат украинские слова (`Київ` из TZ, `Дмитро` из юзера, `Обід` из календаря) — Claude копирует их в русский текст без перевода.

**Цель:** morningBrief вызывает `web_search` сам когда нужно, и выдаёт текст на одном языке (русский).

**Подход (B из brainstorm):** ввести tool-loop в `morningBrief.ai.ts`, проброс только `web_search` tool. Никаких PII/confirm/SSE — это автономный handler, не user-facing chat.

## Context (from discovery)

- `packages/server/src/cognition/handlers/morningBrief.ai.ts` — **71 строка**, текущий `callMorningBriefAI` шлёт один-shot `anthropic.messages.create` без tools.
- `packages/server/src/cognition/handlers/morningBrief.ts` — orchestrator, вызывает `callMorningBriefAI`. Изменений **не требует** (интерфейс сохраняем).
- `packages/server/src/ai/tool-loop.ts:28` — полноценный `runToolLoop` с SSE/PII/confirms — **тяжеловат** для morningBrief (avoid reuse).
- `packages/tool-web-search/src/index.ts` — `createWebSearchTool()` возвращает `ToolDefinition`.
- `packages/server/src/tools/base.ts` — `toClaudeTool()` конвертит `ToolDefinition` → Anthropic Tool schema.
- `packages/server/src/cognition/__tests__/handlers/morningBrief.ai.test.ts` — существующие тесты (nock, fake anthropic).

## Development Approach

- **Testing approach:** Regular (код → тесты в том же таске).
- Сохранить ollama fallback path (сейчас через env `LOCAL_LLM_MODE`).
- Ollama path **остаётся без tools** (brief не критичен, Ollama + tool use в R2 менее стабилен) — fallback выдаёт текст без погоды.
- Claude path получает `web_search` tool с лимитом итераций 5.

## Testing Strategy

- **Unit tests:** обязательны.
- Mock anthropic client: первый ответ — `tool_use` с `web_search`, второй — `text` с финальным brief'ом. Проверить что tool executed и результат попал в финальный текст.
- Edge: tool error → brief должен всё равно вернуть текст (graceful degradation), без throw.
- Язык: проверить что в prompt'е есть инструкция перевода (через output).

## Progress Tracking

- `[x]` сразу как готово.
- ➕ для новых найденных задач.
- ⚠️ для блокеров.

## Implementation Steps

### Task 1: Язык — усилить SYSTEM_PROMPT

- [x] в `morningBrief.ai.ts` заменить `SYSTEM_PROMPT` на:
  ```
  Ты — R2, персональный ассистент. Язык ответа — ТОЛЬКО русский.

  ВАЖНО: входные данные могут содержать украинские слова (имена, города, пункты календаря, таймзона). Переводи их на русский:
  - Київ → Киев
  - Дмитро → Дмитрий
  - Обід → Обед
  - Вечеря → Ужин
  и аналогично для любых других ук. слов. Не копируй украинские слова в русский текст.
  ```
- [x] обновить `morningBrief.ai.test.ts`: добавить case проверяющий что в system prompt есть фраза про перевод (substring match).
- [x] `npm -w @r2-d2/server test -- morningBrief.ai` — pass.

### Task 2: Tool-loop с web_search в callMorningBriefAI

- [x] в `morningBrief.ai.ts` принять в `CallParams` **новый опциональный** `webSearchTool: ToolDefinition | null` (импорт из `@r2/tools` или передаётся сверху).
- [x] переписать `callClaude(...)` → `callClaudeWithTools(...)`:
  - [x] если `webSearchTool` передан → собрать `tools` массив через `toClaudeTool`.
  - [x] цикл до 5 итераций: `anthropic.messages.create({ model, max_tokens, system, messages, tools })`.
  - [x] если `stop_reason === 'tool_use'` → найти `tool_use` блок, вызвать `webSearchTool.handler(params, ctx={})`, добавить `tool_result` в messages, continue.
  - [x] если `stop_reason === 'end_turn'` или iteration limit → извлечь текст из `content[].text`, return.
  - [x] если tool handler бросил / вернул `success=false` → вставить `tool_result` с `is_error: true` и content = текст ошибки, continue (LLM сам решит что писать без погоды).
- [x] ollama path оставить как есть (без tools).
- [x] обновить `morningBrief.ts` deps: добавить `webSearchTool?: ToolDefinition | null`, прокинуть в `callMorningBriefAI`.
- [x] в `index.ts` при создании morningBrief handler — прокинуть `webSearchTool` из registry (или из уже созданного `createWebSearchTool`).
- [x] тесты:
  - [x] happy path: mock anthropic → iter1 `tool_use`, iter2 `text`. Проверить что tool вызван 1 раз, финальный текст содержит результат поиска.
  - [x] no-tool path: mock сразу `text`. Проверить что tool **не** вызывался.
  - [x] tool error: mock handler rejects. Проверить что brief вернул не-пустой текст (fallback).
  - [x] max iterations: mock 6 подряд `tool_use`. Проверить что возвращается текст (пустой или whatever content[].text) после 5 итераций.
  - [x] ollama path: `LOCAL_LLM_MODE=enabled` + ollama set — проверить что tool loop **не** запускался (ollama вызов напрямую).
- [x] `npm -w @r2-d2/server test` — pass.

### Task 3: Regression — check composePrompt содержит координаты города

- [x] проверить в `morningBrief.helpers.ts:composePrompt` — есть ли в prompt'е город юзера (чтобы LLM знал **где** искать погоду). Если нет — добавить. Факт `user.city` или `user.location` из memory должен попадать.
- [x] тест: `composePrompt(data с city='Киев')` → output содержит "Киев".
- [x] если `user.city` отсутствует в memory — LLM должен явно написать "город не задан" вместо рандомного поиска.

### Task 4: Verify acceptance criteria

- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm test` — все пакеты зелёные.
- [ ] manual notes в Post-Completion: завтра утром (2026-04-21) morningBrief должен содержать реальную погоду, без фраз "не могу".

### Task 5: [Final] Обновить документацию

- [ ] `AGENTS.md`: если есть секция про cognition/handlers — упомянуть что morningBrief делает web_search для погоды.
- [ ] env vars документация не меняется (tools реестр используется тот же).

## Technical Details

**Изменяемый интерфейс:**
```ts
// было
interface CallParams { piiProxy; anthropic; ollama?; prompt; signal; }

// станет
interface CallParams {
  piiProxy; anthropic; ollama?; prompt; signal;
  webSearchTool?: ToolDefinition | null;  // новое
}
```

**Порядок вызовов в Claude path:**
1. `piiProxy.anonymize(prompt)` (как сейчас).
2. Tool loop: send → (maybe tool_use → execute → tool_result) → ... → final text.
3. `piiProxy.deanonymize(text)`.

**PII и web_search:**
- Anonymized prompt идёт в Claude → Claude может вызвать `web_search("погода %PII_CITY%")`. Аргумент tool'а будет содержать токен PII, не реальный город.
- Это ломает поиск. **Решение:** перед передачей аргументов в `webSearchTool.handler` — `piiProxy.deanonymize(query)`. Добавить отдельный шаг в tool loop.
- Результат поиска обратно в Claude — заanonymize перед tool_result чтобы сохранить консистентность.
- ⚠️ это добавляет сложности. Если city не PII-sensitive в текущем proxy — проверить и возможно город не анонимизируется; тогда шаг не нужен. Включить проверку в Task 2.

## Post-Completion

**Manual verification:**
- Подождать следующего запуска morningBrief (завтра 07:00+ Kyiv) и проверить в Discord что brief содержит реальный прогноз погоды, текст на русском без украинских слов.

**External system updates:**
- Нет. Supervisor сам подхватит новый master.

**Deployment:**
- feature/morning-brief-tools → dev → master. Supervisor restart.
