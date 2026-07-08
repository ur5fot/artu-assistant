# Morning brief editor from R2 chat

## Overview

Backlog idea: дать владельцу возможность **полностью редактировать утренний
брифинг из чата R2**, без правки кода, `.env` и рестарта.

Сейчас `morningBrief` собирается из фиксированного `composePrompt` и отдельного
статичного `SYSTEM_PROMPT`; из чата можно влиять только косвенно через memory
facts. Нужно сделать нормальный пользовательский слой настроек: что включать,
в каком порядке, каким тоном, какие правила/запреты применять и как посмотреть
черновик следующего брифа.

## User Story

Владелец пишет в R2:

```text
сделай утренний брифинг короче: сначала что висит, потом письма, потом погода.
убери recent context, если там нет важных выводов. всегда заканчивай одним
следующим действием.
```

R2 сохраняет это как настройки morning brief и следующий бриф уже использует
их. Владелец может посмотреть текущие настройки, сбросить их и попросить
черновой preview без ожидания утра.

## Scope

### In Scope

- Новый tool/slash command для управления брифингом из чата, например
  `/брифинг`.
- Сохранение настроек в SQLite, не в `.env`.
- Редактируемые поля:
  - custom instructions / overlay для morning brief;
  - порядок секций;
  - включение/выключение секций: previous period, weather, reminders, notes,
    recent context, pending actions, email recap if available;
  - стиль: короткий / обычный / подробный;
  - финальный блок: next action / no next action;
  - preview следующего брифа по текущим данным.
- Safe reset к дефолтному поведению.
- Audit entry для изменений настроек.

### Out of Scope

- Полный визуальный редактор.
- Редактирование секретов, `.env`, Discord tokens, IMAP accounts.
- Изменение расписания cognition loop в этой задаче.
- Автоматический publish preview в публичные каналы.

## Proposed UX

```text
/брифинг --показать
/брифинг --сбросить
/брифинг --preview
/брифинг --sections pending,emails,weather,reminders
/брифинг --style short
/брифинг <свободные инструкции>
```

Natural language path should work too:

```text
редактируй утренний брифинг: не показывай recent context, если там нет выводов
```

The tool should confirm writes (`permissionLevel: confirm`) because it changes
future proactive behavior.

## Design Sketch

### Storage

Add an additive DB table:

```sql
CREATE TABLE IF NOT EXISTS morning_brief_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instructions TEXT,
  sections_json TEXT,
  style TEXT,
  include_next_action INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
```

Use one row (`id=1`) because R2 is single-owner.

### Tool

Create `packages/tool-morning-brief/`:

- `morning_brief_settings`
- command name: `/брифинг`
- operations:
  - show current settings;
  - update freeform instructions;
  - set sections/order/style;
  - reset to defaults;
  - preview using `gatherData` + `composePrompt` + settings, but do not publish.

### Handler Wiring

- `morningBrief.helpers.ts` reads `MorningBriefSettings`.
- `composePrompt(data, tz, settings)` applies settings:
  - filters sections before rendering;
  - orders selected sections deterministically;
  - appends custom instructions in a clearly bounded block;
  - preserves mandatory safety instructions.
- `morningBrief.ai.ts` gets a small morning-brief-specific overlay, not the
  global `/клод-промпт` overlay.

### Safety

- Never let settings disable safety/privacy constraints.
- Clamp custom instructions length.
- Sanitize section names and unknown style values.
- Preview must be DM/private only.
- Settings must not contain secrets; do not echo `.env` or account IDs.

## Testing Strategy

- DB migration is idempotent.
- Tool tests:
  - show/reset/update/sections/style/invalid input;
  - confirm-level metadata present;
  - preview does not publish.
- `composePrompt` tests:
  - default settings produce current behavior;
  - section filtering/order works;
  - custom instructions appear once in a bounded block;
  - mandatory pending actions directive is not silently dropped when pending
    actions are enabled.
- Handler tests:
  - `morningBrief.run` uses stored settings;
  - broken settings JSON falls back to defaults.

## Acceptance Criteria

- From R2 chat, owner can edit morning brief content and style without restart.
- Owner can inspect and reset current morning brief settings.
- Owner can generate a private preview.
- Default behavior is unchanged when no settings row exists.
- Tests cover migration, tool behavior, prompt rendering, and preview no-publish.

