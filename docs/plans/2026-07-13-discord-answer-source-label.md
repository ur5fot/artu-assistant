# Постоянная отметка источника ответа в Discord

## Outcome

Каждый текстовый ответ основного Discord-чата показывает компактный источник:
`🟢 local` для Ollama/Qwen и `🔵 claude` для Claude API. Метка относится только
к отображению и не записывается в историю или память.

## Tasks

- [x] Заменить escalation-only state на текущий `assistant_source`.
- [x] Добавлять источник при каждом flush текстового Discord-ответа.
- [x] Покрыть local-only, Claude-only и Ollama-to-Claude fallback тестами.
- [x] Прогнать Discord-focused тесты, server build и полный server suite.
- [x] Обновить worklog, опубликовать `dev -> master` и перезапустить R2.

## Verification

- Discord-focused: 73/73 passed.
- Full server suite: 2158/2158 passed across 141 files.
- Server TypeScript build passed.
