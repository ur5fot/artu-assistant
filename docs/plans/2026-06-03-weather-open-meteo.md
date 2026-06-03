# Надёжная погода — Open-Meteo (бриф 3 дня + tool + алерт)

## Overview

Заменить хрупкую погоду через web_search на **Open-Meteo** (без ключа, один эндпоинт,
JSON по координатам). Плюс: 3-дневный прогноз в утреннем брифе, on-demand tool `weather`,
проактивный `weatherAlert` о резкой смене (скачок t°, осадки, заморозок, гроза/ветер).

**Источник истины — спека:**
[docs/superpowers/specs/2026-06-03-weather-open-meteo-design.md](../superpowers/specs/2026-06-03-weather-open-meteo-design.md).
При расхождении — права спека; план обновляем.

## Context (from discovery)

- `packages/server/src/cognition/handlers/morningBrief.helpers.ts` — `gatherData` (город из `memory_facts` :466-473; `BriefData` :495), `composePrompt(data,tz)` (cityLine :533).
- `packages/server/src/cognition/handlers/morningBrief.ai.ts` — `callClaude(...,webSearchTool)` (Claude ищет погоду; убрать инструкцию про погоду).
- `packages/server/src/db.ts` — миграции `db.exec(CREATE TABLE IF NOT EXISTS …)`; сюда `weather_alerts`. `memory_facts` — KV для `user.coords`.
- Cognition `Handler { name, trigger, run }`; tick 60с; `reminderBus.emit('push',{type:'cognition_publish',runId:-1,handler,content})`; гейт на Discord; `emailUrgent` — образец quiet-hours; `distractionPullback` — образец «trigger дёшево / run дорого + дедуп-стор».
- `packages/tool-emails/` — образец тул-пакета (`createTool(deps)`, дублированные `*Like`, package.json/tsconfig, __tests__). Реестр тулов находит пакеты `tool-*`.
- `packages/server/src/index.ts` — env (`envInt`), конструирование deps, регистрация хэндлеров и инъекция в тулы (`imapClientForTool`).
- Node 20+ → глобальный `fetch` (с `AbortSignal.timeout`).

## Development Approach

- **Testing approach: Regular** — код, затем тесты в той же задаче.
- Каждую задачу до конца перед следующей; маленькие фокусные изменения.
- **CRITICAL: каждая задача включает новые/обновлённые тесты** (success + error), отдельными чекбоксами.
- **CRITICAL: все тесты зелёные перед следующей задачей.**
- **CRITICAL: при изменении скоупа — обновить план.**
- Тесты: `npm test --workspace packages/server` / `--workspace packages/tool-weather`; typecheck `tsc --noEmit`.
- Backward-compat: не ломать существующие тесты.

## Testing Strategy

- **Unit-тесты** — в каждой задаче. HTTP — мок глобального `fetch`; время — `now` входным параметром; стор — in-memory/мок.
- Чистые функции (`detectWeatherChanges`, `formatBriefOutlook`, WMO-map) — детерминированные тесты.
- **E2E:** вход — Discord; алерт проверяется на уровне публикации (вызван/нет), не через живой Discord.

## What Goes Where

- **Implementation Steps** (`[ ]`) — код/тесты/доки.
- **Post-Completion** — верификация координат села, активация env, деплой.

## Implementation Steps

### Task 1: Open-Meteo клиент (`weather/open-meteo.ts`)

- [x] `fetchForecast(lat,lon,tz,days=3)` — GET forecast (daily: tmax/tmin/precip_prob_max/weathercode/wind_max; hourly: temp/precip_prob/weathercode), парс в `Forecast`; таймаут ~8с через `AbortSignal.timeout`, на ошибку throw
- [x] `geocode(name,{country='UA',lang='ru'})` → `{lat,lon,name,admin1}|null` (Open-Meteo geocoding, count=1)
- [x] `WMO_RU` map (weathercode→RU) + `formatBriefOutlook(forecast)` → короткий 3-дн RU обзор
- [x] тесты (мок `fetch`): парс forecast, geocode (матч/пусто), WMO→RU, formatBriefOutlook (снапшот), таймаут/HTTP-ошибка → throw
- [x] прогнать тесты — зелёные перед Task 2

### Task 2: `detectWeatherChanges` (чистая детекция)

- [ ] `weather/detect.ts`: `detectWeatherChanges(forecast, now, thresholds)` → `Event[] { type, when, key, message }`: скачок t° (Δmax ≥ tempSwingC), приход осадков (сухо→prob≥precipProbPct в hourly lead-окне / daily завтра), заморозок (tmin≤0 впереди), гроза/сильный ветер (weathercode/wind). `key=type+дата` для дедупа
- [ ] тесты: каждый тип события (есть/нет), «без изменений» → [], стабильные ключи, lead-окно учитывается
- [ ] прогнать тесты — зелёные перед Task 3

### Task 3: Координаты (`weather/coords.ts` `resolveCoords`)

- [ ] `resolveCoords(db, city, geocodeFn)` — читает `user.coords` (JSON `{city,lat,lon}`) из `memory_facts`; если нет ИЛИ `coords.city!==city` → `geocode(city)` + сохранить; иначе вернуть готовые; null если геокод пуст. Override `WEATHER_LAT/LON` имеет приоритет
- [ ] тесты: нет записи → геокод+сохранение; город сменился → перегеокод; совпал → без вызова geocode; геокод пуст → null; env-override
- [ ] прогнать тесты — зелёные перед Task 4

### Task 4: 3-дн погода в утреннем брифе

- [ ] `morningBrief.helpers.ts` `gatherData`: `coords=resolveCoords(...)`; если есть → `weather=fetchForecast(...)` в try (ошибка→null); добавить `weather` в `BriefData`
- [ ] `composePrompt`: секция «## Погода (3 дня)» из `formatBriefOutlook`+daily, если `weather`; иначе «погода недоступна»; cityLine больше не просит искать погоду
- [ ] `morningBrief.ai.ts`/prompt: убрать инструкцию искать погоду через web_search (web_search остаётся для прочего)
- [ ] тесты: `gatherData` кладёт weather (мок модуля); `composePrompt` содержит секцию; `weather=null` → «недоступна»; регресс morningBrief-тестов
- [ ] прогнать тесты — зелёные перед Task 5

### Task 5: Пакет `@r2/tool-weather`

- [ ] создать `packages/tool-weather/` по образцу tool-emails (package.json, tsconfig, src/index.ts, src/types.ts) + добавить в npm workspace
- [ ] tool `weather` `{location?}`, permission `auto`: без location → `resolveUserCoords` → forecast; с location → `weatherClient.geocode`→forecast; вернуть структурный 3-дн + RU-сводку. `WeatherClientLike` дублируется в пакете
- [ ] тесты (`packages/tool-weather/src/__tests__`): без location (мок coords); с location (мок geocode); ошибка клиента → `{success:false,error}`; пустой геокод → понятная ошибка
- [ ] прогнать тесты — зелёные перед Task 6

### Task 6: Таблица `weather_alerts` + стор

- [ ] `db.ts`: `CREATE TABLE IF NOT EXISTS weather_alerts (id INTEGER PK AUTOINCREMENT, event_key TEXT NOT NULL, alerted_at INTEGER NOT NULL)` + индекс `(event_key, alerted_at DESC)`
- [ ] `weather/alert-store.ts` `createWeatherAlertStore({db})`: `recordAlert(key,at)`, `findRecentAlert(key,since)`, `lastCheckAt()`/`setLastCheckAt(at)` (мета: одно-строчная или max(alerted_at))
- [ ] тесты стора: record+find в окне/вне окна, dedupe, lastCheckAt round-trip
- [ ] прогнать тесты — зелёные перед Task 7

### Task 7: Хэндлер `weatherAlert`

- [ ] `cognition/handlers/weatherAlert.ts` `createWeatherAlertHandler(deps)`: `trigger` — `now-lastCheckAt ≥ checkIntervalH` И не тихие часы (`quietStart..quietEnd`) И координаты есть (дёшево, без сети); `run` — `fetchForecast`→`detectWeatherChanges`→для новых событий (нет в `findRecentAlert` в окне dedupeH, `when` в lead-окне) publish (cognition_publish) + `recordAlert`; `setLastCheckAt`; ошибка fetch → `{skip}`
- [ ] формат сообщения алерта (RU, ⚠️/🌧/🥶 по типу), один пинг на событие
- [ ] тесты (мок модуля/стора/clock): trigger throttle/quiet/coords; run публикует новое событие один раз; дедуп повтора; держит событие в тихие часы; ошибка fetch → skip
- [ ] прогнать тесты — зелёные перед Task 8

### Task 8: Конфиг + регистрация/инъекция (`index.ts`)

- [ ] env через `envInt`/строки: `WEATHER_ENABLED`, `WEATHER_ALERT_ENABLED`, `WEATHER_TEMP_SWING_C`(8), `_PRECIP_PROB_PCT`(60), `_LEAD_HOURS`(6), `_CHECK_INTERVAL_H`(3), `_ALERT_DEDUPE_H`(12), `_QUIET_START`(22)/`_END`(8), `WEATHER_LAT`/`WEATHER_LON`(opt), `WEATHER_TZ`(Europe/Kyiv)
- [ ] под `WEATHER_ENABLED`: сконструировать weather-client + `resolveCoords`-замыкание; прокинуть в morningBrief deps и в `tool-weather` (как `imapClientForTool`)
- [ ] под `WEATHER_ALERT_ENABLED && coords && discordReady`: зарегистрировать `createWeatherAlertHandler` в cognitionService
- [ ] `.env.example`: новые `WEATHER_*` с комментариями
- [ ] тесты гейтинга, если есть инфраструктура; иначе — ручная проверка в Post-Completion
- [ ] прогнать тесты — зелёные перед Task 9

### Task 9: Verify acceptance criteria

- [ ] проверить: бриф берёт 3-дн погоду по координатам; tool `weather` (свои/чужой город); алерт ловит резкую смену, дедуп, тихие часы; Open-Meteo-ошибка не роняет
- [ ] полный unit-набор (`packages/server` + `packages/tool-weather`)
- [ ] typecheck (`tsc --noEmit`) — чисто
- [ ] линтер — исправить; покрытие новых модулей по стандарту

### Task 10: Документация

- [ ] README/AGENTS: погода через Open-Meteo (3 дня + tool + алерт), env-флаги, что web_search для погоды больше не используется

## Technical Details

- HTTP — глобальный `fetch` + `AbortSignal.timeout`; один эндпоинт Open-Meteo (надёжнее десятка searxng-движков).
- Координаты храним (`user.coords`), геокод-один-раз/при смене города; override `WEATHER_LAT/LON`.
- Бриф — детерминированный fetch в gatherData, не LLM-tool-call.
- Алерт: trigger дёшев (throttle+quiet+coords), run дорогой (fetch+detect); дедуп на событие; lead — внутридневное (~6ч) / дневное (вечер накануне).

## Post-Completion

*Ручные шаги — без чекбоксов.*

**Верификация координат (обязательно):** после внедрения проверить, что `resolveCoords`
для «Калиновка, Харьковская область, Украина» дал координаты **реального** села
(Open-Meteo мелкие сёла знает не всегда). Если мимо — задать `WEATHER_LAT`/`WEATHER_LON`
вручную (точные из карты).

**Активация:** `WEATHER_ENABLED=true` (+ `WEATHER_ALERT_ENABLED=true`) в живом `.env` + рестарт.

**Деплой:** по flow — dev→master + `git push origin master` (supervisor авто-рестарт).
