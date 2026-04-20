# Multi-turn context понимание в R2

## Overview

R2 не склеивает короткие сообщения пользователя в один logical turn. Пример:

1. Юзер: "Изменить user.nickname"
2. LLM: "что изменить?"
3. Юзер: "Name"
4. LLM: "уточни"
5. Юзер: "Изменить"
6. LLM: "уточни" ← **должен был уже выполнить**

Хотя история (500 сообщений) **доступна** LLM, в system prompt нет правила склеивать multi-turn команды. Плюс каждое мини-сообщение триггерит отдельный вызов LLM, что дорого и шумно.

**Цель:** LLM видит полный intent и реагирует один раз, а не N раз.

**Два компонента:**
1. Правило в system prompt про multi-turn (решает ~80% кейсов).
2. Message coalescing в Discord handler (debounce 1.5с) — гарантирует что LLM вызывается один раз на весь burst.

## Context (from discovery)

- `packages/server/src/ai/prompts.ts:30-37` — `BASE_RULES` (общие для claude и ollama промптов).
- `packages/server/src/channels/discord/bot.ts:209-224` — `messageCreate` handler, queue-based serialization через `userQueues`.
- `packages/server/src/channels/discord/bot.ts:226-345` — `handleMessage` читает историю из БД, append текущего `msg.content`, вызывает `saveMessage` и запускает LLM.
- `packages/server/src/channels/discord/bot.ts:321-330` — history builder уже **сам склеивает** последовательные сообщения одной роли в один turn (`if (last.role === role) last.content += '\n' + r.content`). Значит достаточно сохранить каждое сообщение в БД и запустить LLM один раз — он увидит их как один user turn автоматически.

## Development Approach

- **Testing approach:** Regular (код сначала, потом тесты в том же таске).
- Маленькие атомарные изменения.
- Каждый таск включает unit-тесты на новый/изменённый код, success + edge cases.
- Все тесты должны проходить до перехода к следующему таску.

## Testing Strategy

- **Unit tests:** обязательны в каждом таске.
- Нет e2e — проект использует только vitest unit-тесты.
- Особое внимание: fake timers для тестов debounce.

## Progress Tracking

- `[x]` сразу как только пункт готов.
- ➕ для новых найденных задач.
- ⚠️ для блокеров.

## Implementation Steps

### Task 1: Добавить multi-turn правило в BASE_RULES

- [x] в `packages/server/src/ai/prompts.ts` в `BASE_RULES` добавить правило №8: *«Если юзер отвечает коротко (1-3 слова) или даёт продолжение после твоего уточняющего вопроса — **не спрашивай снова**, собери полную команду из истории предыдущих сообщений и выполни её. Короткий ответ = ответ на твой последний вопрос, не новая тема.»*
- [x] обновить `packages/server/src/ai/__tests__/prompts.test.ts`: добавить тест что `getSystemPrompt()` и `getLocalSystemPrompt()` содержат фразу-маркер из нового правила (напр. "коротко" или "склей из историі" — точная фраза по финальному тексту).
- [x] запустить `npm -w @r2-d2/server test -- prompts` — должны пройти (workspace имя: `@r2/server`).

### Task 2: Message coalescing с 1.5с debounce

Решение: в `messageCreate` сохраняем сообщение в БД сразу, запускаем debounce-таймер 1.5с. Если приходит новое сообщение — таймер сбрасывается и сообщение тоже сохраняется. Когда таймер отстреливает — вызываем `handleMessage` один раз. `handleMessage` читает историю из БД (где уже все сообщения буста) и не вызывает `saveMessage` повторно.

- [x] в `packages/server/src/channels/discord/bot.ts` добавить structure `pendingMessages: Map<string, { timer: NodeJS.Timeout; lastMsg: Message }>` рядом с `userQueues` (~строка 149).
- [x] вынести env-переменную `DISCORD_COALESCE_MS` (дефолт 1500) — добавить в `deps` через `createDiscordBot` options или читать из `process.env`.
- [x] изменить `messageCreate` handler (строки 209-224):
  - [x] сразу сохранять сообщение в БД через `deps.saveMessage` с новым `messageId` (перенести логику из `handleMessage`).
  - [x] если есть pending entry для `userId` — clearTimeout старого таймера, обновить `lastMsg`.
  - [x] если нет — создать новую запись.
  - [x] при срабатывании таймера: удалить entry, вызвать существующий pipeline через `userQueues` с `handleMessage(lastMsg, { alreadySaved: true })`.
- [x] изменить сигнатуру `handleMessage(msg, opts?)`: если `opts.alreadySaved` — **не вызывать** `deps.saveMessage` и **не** делать `built.push({ role: 'user', content: msg.content })` (history из БД уже содержит всё). `userMessageId`/`userMessageTimestamp` взять из сохранённой записи (добавить возврат `saveMessage` или читать последнюю строку по source+userId).
  - [x] альтернативно проще: сохранять в `pendingMessages` не только `lastMsg` но и `lastMessageId`/`lastTimestamp` от первого save, использовать их в `handleMessage`.
- [x] добавить graceful shutdown: при получении SIGTERM/close — прогнать все pending таймеры синхронно (или прервать). Достаточно заметки в коде — полный shutdown-path вне скоупа этого плана.
- [x] unit-тест в `packages/server/src/channels/discord/__tests__/bot.test.ts`:
  - [x] success: три сообщения за 500мс → `runChatRequest` вызывается **1 раз**, `saveMessage` вызывается 3 раза (по одному на каждое сообщение), история содержит все три.
  - [x] пауза: два сообщения с gap 2с → `runChatRequest` вызывается 2 раза.
  - [x] один сообщение → работает как раньше (1 вызов после 1.5с).
  - [x] env override: `DISCORD_COALESCE_MS=500` → debounce 500мс.
  - [x] использовать `vi.useFakeTimers()` и `vi.advanceTimersByTime`.
- [x] запустить `npm -w @r2-d2/server test` — все тесты пакета должны проходить.

### Task 3: Интеграционная проверка + typecheck

- [x] `npm run typecheck` в корне репо — 0 ошибок. (В репо нет root `typecheck` script; запустил `tsc --noEmit` на `packages/server` — чисто. Пакеты `tool-code-deploy` и `tool-eval-run` имеют pre-existing ошибки в test-файлах (`ToolDeps` shape), не связаны с этим планом — подтверждено сравнением с base.)
- [x] `npm test` в корне — все пакеты зелёные. (75 файлов / 785 тестов — все pass.)
- [x] проверить что `currentUserMessageId`, передаваемое в `runChatRequest` → tool-loop → memory tools, указывает на **последнее** сообщение буста (чтобы `memory_forget_last` работал на весь burst через history collapse). (Верифицировано: `firePending` в `bot.ts:233-237` передаёт `entry.lastMessageId`, который обновляется на КАЖДОМ incoming msg в `messageCreate` handler.)
- [x] верифицировать: `packages/tool-memory/src/index.ts` в `memory_forget_last` берёт facts по `user_message_id` — с коалесингом facts привязаны только к последнему msg из burst. Документировать в комментарии или fix: привязывать extracted facts ко всем msg_id из burst (оставить как TODO если скоуп большой). (Документировано: `service.ts` `runIndexTurn` — добавлен комментарий про burst-anchor semantics. Дополнительный fix (multi-id attach) оставлен out-of-scope: `findLastUserMessageBefore` возвращает последний prior user msg, который есть anchor, поэтому поведение корректно.)

### Task 4: Verify acceptance criteria

- [ ] manual smoke (описание в Post-Completion): отправить в Discord "Изменить user.nickname" → "Name" → "Изменить" в течение 1.5с — LLM должен отработать один раз и либо выполнить, либо объяснить почему не может.
- [ ] `npm run lint` — чисто.
- [ ] полный `npm test` — 100% pass.

### Task 5: [Final] Обновить документацию

- [ ] обновить `AGENTS.md` / `README.md` если там описан flow сообщений — добавить упоминание debounce и env `DISCORD_COALESCE_MS`.
- [ ] обновить CLAUDE.md (project knowledge) если есть секция про message handling.

## Technical Details

**Прежний flow:**
```
messageCreate → userQueues.then(handleMessage)
  → read history → append msg → saveMessage → runChatRequest
```

**Новый flow:**
```
messageCreate → saveMessage + reset debounce timer
  ⏱ 1.5s idle ⏱
  → userQueues.then(handleMessage(lastMsg, { alreadySaved: true }))
  → read history (уже содержит все msg буста) → runChatRequest
```

**Зависимости:**
- `userQueues` остаётся — обеспечивает что пока LLM обрабатывает один burst, следующий не может начаться параллельно.
- `pendingMessages` и `userQueues` — независимы: первый копит входящие, второй сериализует обработанные.

**Env vars:**
- `DISCORD_COALESCE_MS` — дефолт 1500, в тестах можно override.

## Post-Completion

**Manual verification:**
- Запустить R2 локально, отправить через Discord DM серию коротких сообщений и проверить что бот отвечает один раз.
- Проверить что долгие thinking-паузы (>1.5с между сообщениями юзера) правильно ломают burst — LLM вызывается на каждую часть.

**External system updates:**
- Нет — изменения чисто в server-пакете.

**Deployment:**
- После merge в `feature/memory-editing-tools` → sync `dev` ← `master` → `feature/multi-turn-context` → `dev` → `master` (по deploy_flow memory).
- Supervisor сам поднимет новую версию.
