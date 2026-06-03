# Надёжная погода — Open-Meteo (бриф 3 дня + on-demand tool + алерт о резкой смене)

## Overview

Сейчас погода в утреннем брифе тянется общим веб-поиском (searxng) — ссылки/сниппеты,
которые Claude парсит. Хрупко: неоднозначный город (резолвилось в Kalinovka, Russia),
таймауты движков в плохой сетевой день → «погода недоступна».

**Цель:** заменить на **Open-Meteo** (бесплатный, без ключа, один эндпоинт, чистый
JSON по координатам), и поверх этого:
1. **3-дневный прогноз/анализ** в брифе (а не только сегодня).
2. **On-demand tool `weather`** — спросить погоду в чате в любой момент.
3. **Проактивный алерт `weatherAlert`** — предупреждать заранее о **резкой смене**
   (скачок t°, приход осадков, заморозок, сильный ветер), один раз на событие, с
   нормальным lead-time и уважением тихих часов.

## Scope

**In:**
- Модуль `packages/server/src/weather/open-meteo.ts`: `fetchForecast(lat,lon,tz,days=3)` (Open-Meteo forecast: daily + hourly), `geocode(name)` (Open-Meteo geocoding), WMO weathercode→RU, `formatBriefOutlook(forecast)` (короткий 3-дн RU обзор), `detectWeatherChanges(...)` (чистая детекция резкой смены).
- Координаты: `resolveCoords(db, city)` — читает `user.coords` из `memory_facts`; если нет/город сменился → геокодит (country=UA, lang=ru), сохраняет. Рантайм-прогноз — по готовым координатам.
- Утренний бриф: `gatherData` детерминированно тянет 3-дн прогноз → структурная секция «Погода (3 дня)» в `composePrompt`; убрать инструкцию искать погоду через web_search (web_search остаётся для прочего).
- `packages/tool-weather/` — tool `weather` (`{ location? }`): без location → координаты юзера; с location → геокод. Инжектит `WeatherClientLike` (как tool-emails инжектит imapClient).
- Cognition-хэндлер `weatherAlert` (`cognition/handlers/weatherAlert.ts`): trigger = дешёвый гейт (throttle ~3ч + не тихие часы + есть координаты), run = fetch + `detectWeatherChanges` + публикация новых событий в Discord. Дедуп через таблицу `weather_alerts`.
- Конфиг через `envInt`; регистрация/инжекция в `index.ts`. Тесты (мок fetch/clock/store).

**Out:**
- Свой геокодер/карты для сверх-точного резолва села — берём Open-Meteo geocoding + ручную верификацию координат (Post-Completion). Если село не находится — координаты задаются вручную.
- Радар/почасовой UI, исторические данные, несколько локаций одновременно — Future.
- Замена web_search где-то ещё — не трогаем, только погоду в брифе.

## Current state

- `morningBrief.helpers.ts`: `gatherData` (читает `city` из `memory_facts` ключи `user.city`/`user.location`, :466-473; возвращает `BriefData` :495), `composePrompt(data,tz)` (cityLine :533, секции; weather сейчас не структурирован — Claude ищет сам через web_search).
- `morningBrief.ai.ts`: `callClaude(..., webSearchTool)` — Claude вызывает web_search для погоды.
- `memory_facts` — структурный KV (key/value/superseded_by/forgotten/last_mentioned_at). Сюда же `user.coords`.
- Cognition `Handler { name, trigger(state,ctx), run(ctx) }`; tick 60с; публикация — `reminderBus.emit('push',{type:'cognition_publish',runId,handler,content})`; гейт на живой Discord (как emailUrgent/distraction). Регистрация в `index.ts`. `emailUrgent` — образец quiet-hours (`quietStart`).
- Тул-пакеты (`packages/tool-emails`) — образец инъекции зависимостей (`createTool(deps)`, дублированные `*Like` интерфейсы).
- `env-utils.envInt(raw,fallback,min,max?)`.

## Design

### 1. Модуль `weather/open-meteo.ts`

- `fetchForecast(lat, lon, tz, days=3)`: GET `api.open-meteo.com/v1/forecast` с `daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode,wind_speed_10m_max`, `hourly=temperature_2m,precipitation_probability,weathercode`, `timezone=tz`, `forecast_days=days`. Парс в `Forecast { days: DayForecast[]; hours: HourForecast[] }`. Таймаут (~8с), на ошибку — throw (вызывающий деградирует).
- `WMO_RU: Record<number,string>` — weathercode → «ясно/облачно/дождь/гроза/снег/туман…».
- `formatBriefOutlook(forecast)` → короткий RU обзор 3 дней с подсветкой заметного («сегодня ясно 12–20°, завтра дождь, послезавтра холодает до 8°»).
- `geocode(name, {country='UA', lang='ru'})` → `{lat,lon,name,admin1}|null` (Open-Meteo geocoding, `count=1`).

### 2. Координаты (`resolveCoords`)

`user.coords` в `memory_facts` хранит `{city, lat, lon}` (JSON). `resolveCoords(db, city)`:
если записи нет ИЛИ `coords.city !== city` (город сменился) → `geocode(city)`, сохранить
`{city,lat,lon}`; иначе вернуть готовые. Так смена города авто-перегеокодит, а рантайм
не геокодит каждый раз. Верификация реального места — Post-Completion.

### 3. Утренний бриф (3 дня, детерминированно)

- `gatherData`: `coords = resolveCoords(db, city)`; если есть → `weather = fetchForecast(coords, tz, 3)` (в try; на ошибку `weather=null`). Добавить `weather` в `BriefData`.
- `composePrompt`: если `weather` есть → секция «## Погода (3 дня)» с `formatBriefOutlook` + сырые daily-числа; cityLine больше не просит искать погоду. Если `weather=null` → «погода недоступна» (как сейчас, но это теперь редкий случай — один эндпоинт).
- Claude компонует погодную часть брифа из готовых данных, не из web_search.

### 4. On-demand tool `weather`

`packages/tool-weather/` — `createTool({ weatherClient: WeatherClientLike, resolveUserCoords })`.
Tool `weather`, params `{ location?: string }`, permission `auto`. Без `location` →
координаты юзера (`resolveUserCoords`); с `location` → `weatherClient.geocode` → forecast.
Возвращает структурный 3-дн прогноз + готовую RU-сводку. `WeatherClientLike` дублируется
в пакете (как `ImapClientLike`); сервер инжектит реальный клиент.

### 5. Хэндлер `weatherAlert` (проактивный)

- `trigger(state)` — дёшево: прошло ≥ `checkIntervalH` с последней проверки (`weather_alerts`/state) **и** не тихие часы **и** координаты есть. Без сети.
- `run(ctx)`: `fetchForecast` → `detectWeatherChanges(forecast, now, thresholds)` → список событий `{ type, when, key, message }`. Для каждого, чьего `key` нет в недавних `weather_alerts` и чьё `when` в пределах lead-окна → опубликовать (cognition_publish → Discord) + записать ping. Обновить last-check. Ошибка fetch → `{skip}`, повтор следующей проверки.
- `detectWeatherChanges` (чистая, тестируемая) ловит:
  - **скачок t°**: |max(day+1) − max(day0/текущ)| ≥ `tempSwingC` → «завтра резко холоднее/теплее (Δ°)»;
  - **приход осадков**: сухо сейчас → `precipitation_probability ≥ precipProbPct` (hourly в lead-окне или daily завтра) → «через ~Nч дождь/гроза» / «завтра дождь»;
  - **заморозок**: `temperature_2m_min ≤ 0` впереди, если ранее не было → «ночью первый минус»;
  - **сильный ветер / гроза**: weathercode гроза/heavy или `wind_speed_10m_max ≥` порога → алерт.
  - Каждое событие — `key = type+дата` (дедуп на событие).
- **Lead-time:** внутридневное (часовой прогноз) — алерт когда событие в пределах `leadHours` (~6ч). Дневное (next-day) — алерт вечером накануне (в окне «вечер»), не среди дня/ночью.
- **Тихие часы** (`quietStart`..`quietEnd`, 22–08): не публикуем; держим до утра.

### 6. Данные: `weather_alerts`

`CREATE TABLE IF NOT EXISTS weather_alerts (id INTEGER PK, event_key TEXT NOT NULL, alerted_at INTEGER NOT NULL)` + индекс `(event_key, alerted_at DESC)`. Стор: `recordAlert(key, at)`, `findRecentAlert(key, since)`, `lastCheckAt()`/`setLastCheckAt(at)` (последняя проверка — отдельная одно-строчная мета или max(alerted_at)). Дедуп-окно `alertDedupeH`.

### 7. Конфиг (env, через `envInt`/строки)

| Var | default | примечание |
|---|---|---|
| `WEATHER_ENABLED` | `false` | мастер-флаг фичи |
| `WEATHER_ALERT_ENABLED` | `false` | проактивный алерт |
| `WEATHER_TEMP_SWING_C` | 8 | порог скачка t° |
| `WEATHER_PRECIP_PROB_PCT` | 60 | порог вероятности осадков |
| `WEATHER_LEAD_HOURS` | 6 | lead для внутридневного |
| `WEATHER_CHECK_INTERVAL_H` | 3 | как часто проверять прогноз |
| `WEATHER_ALERT_DEDUPE_H` | 12 | не повторять то же событие |
| `WEATHER_QUIET_START`/`_END` | 22 / 8 | тихие часы алерта |
| `WEATHER_LAT`/`WEATHER_LON` | — | ручной override координат (если геокод села мимо) |
| `WEATHER_TZ` | `Europe/Kyiv` | таймзона прогноза |

Алерт регистрируется тройным гейтом `WEATHER_ALERT_ENABLED && coords && discordReady`.

## Error handling

- Open-Meteo недоступен/таймаут (сеть моргнула): бриф → `weather=null` («погода недоступна»); tool → `{success:false,error}`; `weatherAlert.run` → `{skip}`, повтор. Никогда не роняем тик/бриф.
- Геокод не нашёл город: `resolveCoords` → null → погода отключена + лог-подсказка (задать `WEATHER_LAT/LON` вручную). 
- Один внешний эндпоинт (Open-Meteo) намного устойчивее десятка searxng-движков.

## Testing

- `open-meteo`: мок `fetch` — парс forecast (daily+hourly), WMO→RU, `formatBriefOutlook` (снапшот), `geocode` (матч/пусто), таймаут→throw.
- `detectWeatherChanges` (чистая): скачок t° (есть/нет), приход осадков (внутридневной/завтра), заморозок, гроза/ветер, «без изменений», дедуп-ключи. Детерминированно (now/forecast — входные).
- `resolveCoords`: нет записи → геокод+сохранение; город сменился → перегеокод; совпал → без сети.
- бриф: `gatherData` кладёт weather (мок модуля); `composePrompt` содержит секцию погоды; `weather=null` → «недоступна».
- tool-weather: без location → координаты юзера; с location → геокод; ошибка клиента → error.
- `weatherAlert`: trigger throttle/quiet/coords; run публикует новое событие один раз, дедупит повтор, держит в тихие часы, на ошибке fetch — skip.

## Decisions / defaults

- Координаты **храним** (геокод-один-раз + кэш по городу), не геокодим на лету. Ручной override `WEATHER_LAT/LON`.
- Погода в брифе — **детерминированный fetch в gatherData**, не LLM-tool-call (надёжнее).
- Пороги/lead/тихие часы — env, дефолты выше.
- Open-Meteo без ключа; таймзона по умолчанию Europe/Kyiv.

## Future

- Несколько локаций / «погода в пути».
- Почасовая детализация в чате, радар осадков.
- Более умный «анализ» (тренды недели, аномалии vs сезон).
- Вынести Open-Meteo клиент в `@r2/weather` пакет, если понадобится вне сервера.

## Post-Completion

**Верификация координат (обязательно):** после внедрения проверить, что
`resolveCoords` для «Калиновка, Харьковская область, Украина» дал координаты
**реального** села (Open-Meteo geocoding мелкие сёла знает не всегда). Если мимо —
задать `WEATHER_LAT`/`WEATHER_LON` вручную (взять точные из карты).

**Активация:** `WEATHER_ENABLED=true` (+ `WEATHER_ALERT_ENABLED=true` для алерта) в живом `.env` + рестарт.

**Деплой:** по flow — dev→master + push (supervisor авто-рестарт).
