# R2 Always-On via launchd — Process-Liveness Resilience (Pain: silent downtime)

## Overview

**Проблема.** R2 крутится в dev-режиме `npm run dev` (`tsx watch`), который **не
респавнит процесс при крэше/сне** — `tsx watch` перезапускает worker только на
изменение файла. 2026-05-31 ~18:47 R2 умер (совпало со сном машины) и пролежал
~14 минут, пока его не подняли вручную. Это **другой класс отказа**, чем
сегодняшний in-process blind-detection (тот ловит «процесс жив, но osascript
отдаёт null»; здесь умер весь процесс — поллеру некому считать слепые тики).

**Что уже есть.** `packages/supervisor` умеет `fork` worker'а
(`packages/server/src/index.ts` через tsx, `useTsx: true`), **авто-рестарт при
крэше** (backoff `[500,2000,5000]ms`, crashloop-guard 3/60с → пауза 30с) и watch
`master` (деплой). Чего нет: supervisor запускается только вручную в терминале —
**не переживает logout/reboot и не стартует сам**.

**Фикс.** LaunchAgent (`launchd`), который держит **supervisor** всегда живым:
`RunAtLoad` (старт при логине) + `KeepAlive` (перезапуск, если сам supervisor
умрёт) + лог-файлы (вместо терминала). Получаем два уровня надзора:
**launchd → supervisor → worker**. Крэш worker'а лечит supervisor (секунды);
смерть самого supervisor'а или ребут лечит launchd.

**Решения (рекомендации, зафиксированы до плана — отвергаемы на ревью):**
- **Supervisor запускать через `tsx` из исходников** (`npx tsx
  packages/supervisor/src/index.ts`), не из `dist`. Worker и так идёт через tsx;
  так деплой (`git pull master`) подхватывается без шага сборки, нет протухшего
  `dist`.
- **PATH/node через login-shell**: plist зовёт `/bin/zsh -lc <wrapper>`, wrapper
  получает nvm-node из профиля. Не пиним версионный nvm-путь.
- **Docker — best-effort**: wrapper делает `docker compose up -d || true`
  (нужен только code-task тулзам, лениво; не должен ронять старт). Ollama не
  трогаем — `LOCAL_LLM_MODE=disabled`.
- **Логи** → `~/Library/Logs/r2-supervisor.{out,err}.log` (заодно закрывает
  «логи уходили в терминал, который никто не читает»).
- **Guard от конфликта**: install/ wrapper предупреждают, если `npm run dev`
  уже держит порт 3004.

**Out of scope (отдельные итерации):**
- Health-poll watchdog supervisor'ом + Discord-алерты (план #2, обсуждали).
- Subsystem-freshness в `/api/health`.
- launchd для Docker/Ollama самих по себе.

## Context (from discovery)

**Файлы (новые, в репо):**
- `scripts/gen-r2-launchd-plist.mjs` — чистый генератор plist-XML по параметрам
  (repo path, label, shell, wrapper path, log paths). Тестируемый.
- `scripts/r2-service.sh` — wrapper, который зовёт plist: resolve node, `cd`
  repo, `docker compose up -d || true`, `exec npx tsx
  packages/supervisor/src/index.ts`.
- `scripts/install-r2-service.sh` — генерит plist → пишет в `$TARGET_DIR`
  (default `~/Library/LaunchAgents`) → `launchctl` load (флаги `--no-load`,
  `TARGET_DIR=` для тестов/dry-run).
- `scripts/uninstall-r2-service.sh` — `launchctl` unload + удалить plist.
- `scripts/__tests__/gen-r2-launchd-plist.test.mjs` — vitest на генератор.

**Паттерны/факты для опоры:**
- root `package.json`: `start` = `node packages/supervisor/dist/index.js`,
  `start:build` = build shared+server+supervisor + `npm start`. (Мы запускаем
  через tsx, но скрипты — референс.)
- `packages/supervisor/src/index.ts`: env `R2_SUPERVISOR_PORT=3100`,
  `R2_GIT_WATCH_BRANCH=master`, читает `.env` из корня репо.
- `scripts/dev.sh`: `npm run dev` поднимает Docker + (опц.) Ollama + server +
  client с teardown-трапом — supervisor этого НЕ делает (только server).
- vitest — тест-раннер репо; `plutil -lint` есть в macOS для валидации plist.

**Без новых внешних зависимостей.**

## Development Approach

- **Testing approach: TDD** (тест генератора до реализации).
- Малые сфокусированные изменения; тесты после каждого таска; все зелёные до
  следующего.
- **Системные мутации (`launchctl load`, запись в `~/Library/LaunchAgents`)
  НЕ выполняются в ходе таск-исполнения** — только генерация/валидация
  артефактов. Реальная установка — Post-Completion на живой машине.
- Скрипты должны поддерживать dry-run (`TARGET_DIR=`, `--no-load`), чтобы тесты
  не трогали систему.
- Scoped прогон: `npm -w @r2/server test -- <pattern>` (для server-тестов) и
  корневой `npm test`/`npx vitest run scripts/__tests__/...` для скриптов.

## Testing Strategy

- **Unit (vitest)** на `gen-r2-launchd-plist.mjs`: содержит обязательные ключи
  (`Label`, `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `StandardOutPath`,
  `StandardErrorPath`, `WorkingDirectory`, `ThrottleInterval`); пути
  интерполированы из аргументов; вывод проходит `plutil -lint` (записать во
  временный файл, прогнать `plutil`; если `plutil` недоступен в CI — fallback на
  XML-parse).
- **Install-скрипт в dry-run**: тест запускает `TARGET_DIR=$(mktemp -d)
  install-r2-service.sh --no-load`, ассертит, что plist создан в TARGET_DIR и
  валиден; система не тронута.
- **Статика скриптов**: `bash -n` (syntax) на всех `.sh`; `shellcheck` если
  доступен (иначе пропустить с логом).
- **Нет live-launchd тестов** — реальная регистрация и resilience (kill/ребут)
  проверяются вручную в Post-Completion.

## Progress Tracking

- `[x]` сразу по завершении; ➕ новые подзадачи; ⚠️ блокеры.

## What Goes Where

- **Implementation Steps** (`[ ]`): repo-артефакты, тесты, docs.
- **Post-Completion** (без чекбоксов): установка и проверка на живом macOS.

## Implementation Steps

### Task 1: plist-генератор + тесты (TDD)

- [x] написать падающий тест `scripts/__tests__/gen-r2-launchd-plist.test.mjs`:
  - вызывает экспорт `generatePlist({ label, repoPath, shellPath, wrapperPath,
    outLog, errLog, throttle })` и проверяет: все обязательные ключи
    присутствуют; `ProgramArguments` = `[shellPath, '-lc', wrapperPath]`;
    `WorkingDirectory === repoPath`; `RunAtLoad`/`KeepAlive` = true;
    лог-пути проставлены.
  - пишет вывод во временный файл и валидирует через `plutil -lint` (если есть),
    иначе парсит XML и проверяет структуру.
- [x] реализовать `scripts/gen-r2-launchd-plist.mjs`: экспортируемая чистая
  функция `generatePlist(opts) -> string` (валидный `<?xml … plist 1.0>`),
  плюс CLI-режим (печать в stdout по argv/env). Без побочных эффектов.
- [x] прогнать `npx vitest run scripts/__tests__/gen-r2-launchd-plist.test` —
  зелёно до Task 2.

### Task 2: wrapper + install/uninstall + dry-run тест

- [x] `scripts/r2-service.sh`: `set -euo pipefail`; resolve node (через
  login-shell PATH; fallback `command -v node`); `cd` в repo root (вычислить от
  `$0`); `docker compose up -d || true` (best-effort, лог в stderr); guard:
  если порт 3004 уже занят (`npm run dev`?) — внятная ошибка и exit; затем
  `exec npx tsx packages/supervisor/src/index.ts`.
- [x] `scripts/install-r2-service.sh`: `set -euo pipefail`; параметры через env
  (`TARGET_DIR` default `$HOME/Library/LaunchAgents`, `LABEL` default
  `com.r2.supervisor`) и флаг `--no-load`; вызвать генератор → записать
  `$TARGET_DIR/$LABEL.plist`; если не `--no-load`: `launchctl unload` старого
  (|| true) + `launchctl load -w`; вывести путь к логам и статус.
- [x] `scripts/uninstall-r2-service.sh`: `launchctl unload -w` + удалить plist
  (идемпотентно).
- [x] тест dry-run (vitest или bash-тест в `scripts/__tests__/`): прогнать
  `TARGET_DIR=$(mktemp -d) bash scripts/install-r2-service.sh --no-load` →
  ассертить, что `$TARGET_DIR/com.r2.supervisor.plist` создан и валиден
  (`plutil -lint`); НИЧЕГО в `~/Library/LaunchAgents` и launchctl не тронуто.
- [x] `bash -n` на всех новых `.sh`; `shellcheck` если установлен.
- [x] прогнать тесты скриптов — зелёно до Task 3.

### Task 3: docs + приёмка

- [x] `README.md`: секция **«Always-on (launchd)»** — зачем (resilience к
  крэшу/сну/ребуту), как поставить (`bash scripts/install-r2-service.sh`),
  где логи (`~/Library/Logs/r2-supervisor.*.log`), как снять
  (`uninstall-r2-service.sh`), и предупреждение «не запускать одновременно с
  `npm run dev` (конфликт порта 3004)».
- [x] `AGENTS.md`: 1–2 строки про supervisor-as-service + что worker и
  supervisor идут через tsx, деплой подхватывается git-watcher'ом.
- [x] приёмка: `npm test` (или scoped vitest на новые тесты) — зелёно;
  `bash -n` всех скриптов чисто; генератор → `plutil -lint` OK; убедиться, что
  таск-прогон НЕ создал ничего в `~/Library/LaunchAgents` и не звал `launchctl`.

## Technical Details

### Два уровня надзора
`launchd` (KeepAlive) → `supervisor` (WorkerManager: fork + auto-restart +
crashloop-guard) → `worker` (server via tsx). launchd чинит смерть supervisor'а
/ ребут; supervisor чинит крэш worker'а. `ThrottleInterval=10` против тайт-лупа.

### Почему tsx, а не dist
Worker уже `useTsx:true`. Если и supervisor гнать через `npx tsx
packages/supervisor/src/index.ts`, то нет шага сборки и протухшего `dist`;
git-watcher после `git pull master` рестартит worker, который читает свежие
исходники. Минус — старт чуть медленнее (разовый), приемлемо для always-on.

### PATH / nvm
plist `ProgramArguments = ["/bin/zsh","-lc","<repo>/scripts/r2-service.sh"]`.
Login-shell (`-l`) подтягивает nvm → node на PATH. Не хардкодим версионный путь
вида `~/.nvm/versions/node/vX/bin`.

### Конфликт с dev
`npm run dev` и service оба биндят 3004. Service — для always-on; dev — для
активной разработки. wrapper и install предупреждают/отказываются при занятом
3004. Перед установкой остановить `npm run dev`.

## Post-Completion

*Без чекбоксов — нужен живой macOS (выполняется после мерджа, вручную или со
мной).*

1. Остановить dev: Ctrl-C в терминале `npm run dev` (его cleanup сделает
   `docker compose down`).
2. `docker compose up -d` (вернуть сервисы для code-task тулз).
3. `bash scripts/install-r2-service.sh` → проверить
   `launchctl list | grep com.r2.supervisor` (PID присвоен).
4. Проверить: `curl localhost:3004/api/health` → JSON `R2 online`; в
   `data/r2.db` идут свежие `window_history` сэмплы; логи в
   `~/Library/Logs/r2-supervisor.out.log`.
5. **Resilience-тесты:**
   - убить worker (`pkill -f "server/src/index.ts"`) → supervisor респавнит за
     секунды (виден `[supervisor] Restarting worker`), 3004 снова отвечает;
   - убить supervisor (`launchctl kill TERM …` или kill PID) → launchd
     поднимает заново (RunAtLoad/KeepAlive);
   - sleep/wake машины → R2 продолжает писать после пробуждения;
   - (опц.) reboot → R2 поднимается сам при логине.
6. Снять при необходимости: `bash scripts/uninstall-r2-service.sh`.
