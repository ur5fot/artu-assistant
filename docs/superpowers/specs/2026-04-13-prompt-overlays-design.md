# Prompt Overlays — редагування надстройки промпту з чату

## Мета

Дати можливість редагувати системний промпт Claude та Ollama прямо з чату без
рестарту сервера. Базовий (захардкоджений) промпт лишається незмінним — з чату
керується лише «надстройка»: додатковий блок інструкцій, що конкатенується до
базового.

## Не-цілі

- Повна заміна системного промпту
- Кілька іменованих пресетів
- UI-редактор (лише slash-команди)
- Natural-language роутинг («поміняй промпт на …»)
- Версіонування / історія надстройок

## Архітектура

### Сховище

Нова таблиця SQLite у `packages/server/src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS prompt_overlays (
  model TEXT PRIMARY KEY,       -- 'claude' | 'ollama'
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

API (синхронне, через `better-sqlite3`):

- `getOverlay(model: 'claude' | 'ollama'): string | null`
- `setOverlay(model, text: string): void` — INSERT OR REPLACE, `updated_at = Date.now()`
- `clearOverlay(model): void` — DELETE

Кеш не потрібен: `SELECT ... WHERE model = ?` дешевий, викликається раз на turn.

### Інтеграція з промптами

У `packages/server/src/ai/prompts.ts`:

- `getSystemPrompt()` (Claude): після збірки базового тексту читає
  `getOverlay('claude')`. Якщо є — додає:

  ```
  \n\n## Додаткові інструкції\n<overlay text>
  ```

- `getLocalSystemPrompt(toolSummary)` (Ollama): те саме для `getOverlay('ollama')`.

Якщо надстройка відсутня або порожня — нічого не додається. Базові правила
(мова, інструменти, безпека) лишаються недоторканими.

### Slash-команди

Два нових інструменти в `registry` (аналогічно існуючим командам з
`packages/server/src/tools/`):

- `/клод-промпт`
- `/лама-промпт`

Кожен приймає:

- позиційний аргумент `text` (опціональний)
- прапорець `--показати`
- прапорець `--скинути`

Логіка handler'а (однакова для обох, різниця лише в `model`):

| Вхід | Дія | Відповідь |
|---|---|---|
| `--показати` | `getOverlay(model)` | поточний текст або `"порожньо"` |
| `--скинути` | `clearOverlay(model)` | `"скинуто"` |
| `<text>` (без прапорців) | `setOverlay(model, text)` | `"збережено"` |
| пусто, без прапорців | error | підказка з usage |
| `--показати` + `<text>` | error | «не можна поєднувати» |
| `--скинути` + `<text>` | error | «не можна поєднувати» |

Результат повертається як tool result, модель озвучує користувачу природною
мовою.

## Data flow

1. Користувач пише `/клод-промпт будь лаконічним`
2. `chat.ts` парсить slash-команду, знаходить tool `клод-промпт` у registry
3. Handler викликає `setOverlay('claude', 'будь лаконічним')`
4. Tool result → модель відповідає «збережено»
5. Наступний запит до Claude → `getSystemPrompt()` зчитує overlay, додає до
   базового промпту
6. Claude бачить нову інструкцію вже в цьому ж чат-turn'і (бо промпт збирається
   на кожен запит)

## Обробка помилок

- Запис > 10 000 символів → error «занадто довгий» (ліміт захищає від випадкової
  вставки гігантського тексту)
- БД помилка → пробрасується вище, стандартна обробка `chat.ts`
- Відсутність overlay при `--показати` → повертається `"порожньо"`, не error

## Тестування

Unit:
- `db.test.ts`: get/set/clear overlay, INSERT OR REPLACE перезаписує, clear не
  падає на відсутньому ключі
- `prompts.test.ts`: overlay конкатенується коли є, не додається коли нема/порожньо,
  роздільники правильні

Integration:
- `chat.test.ts` або новий тест: `/клод-промпт тест` → overlay у БД, наступний
  `getSystemPrompt()` містить «тест»; `/клод-промпт --скинути` → overlay видалено;
  `/клод-промпт --показати` повертає поточне значення

## Файли, що змінюються

- `packages/server/src/db.ts` — нова таблиця, функції `getOverlay`/`setOverlay`/`clearOverlay`
- `packages/server/src/ai/prompts.ts` — конкатенація overlay
- `packages/server/src/tools/` — новий інструмент (один файл на обидві команди
  з параметром `model`, або два тонких wrapper'и)
- `packages/server/src/tools/registry.ts` — реєстрація
- тести: `db.test.ts`, `prompts.test.ts`, tool-level test
