# SearXNG: Замена Brave Search на self-hosted поиск

## Цель

Заменить Brave Search API на self-hosted SearXNG в Docker. Полностью localhost-first, без зависимости от внешних API ключей.

## SearXNG

- Self-hosted метапоисковик (агрегирует Google, Bing, DuckDuckGo и др.)
- Docker image: `searxng/searxng`
- JSON API: `GET http://localhost:8888/search?q=query&format=json`
- Без API ключей, без лимитов

## Изменения

### Новые файлы

- `docker-compose.yml` — SearXNG сервис
- `searxng/settings.yml` — настройки SearXNG (включить JSON format, выбрать engines)
- `searxng/limiter.toml` — отключить rate limiter для localhost

### Изменённые файлы

- `packages/tool-web-search/src/index.ts` — заменить Brave API на SearXNG
- `packages/tool-web-search/__tests__/web-search.test.ts` — обновить тесты
- `.env.example` — убрать `BRAVE_SEARCH_API_KEY`, добавить `SEARXNG_URL`
- `AGENTS.md` — обновить стек (Brave → SearXNG)

## SearXNG JSON Response Format

```json
{
  "results": [
    {
      "title": "Example",
      "url": "https://example.com",
      "content": "Description text..."
    }
  ]
}
```

## Параметры API

- `q` — поисковый запрос
- `format` — `json`
- `categories` — `general` (по умолчанию)
- `pageno` — номер страницы (default 1)

## Docker Compose

```yaml
services:
  searxng:
    image: searxng/searxng
    ports:
      - "8888:8080"
    volumes:
      - ./searxng:/etc/searxng
    restart: unless-stopped
```

## SearXNG Settings

Минимальный `settings.yml`:
- `server.secret_key` — случайный ключ
- `search.formats` — включить `json`
- `engines` — Google, DuckDuckGo, Bing (активные по умолчанию)

## Env Variables

- `SEARXNG_URL` — URL SearXNG instance (default: `http://localhost:8888`)
- Убрать: `BRAVE_SEARCH_API_KEY`

## Permission Level

`web_search` остаётся `auto` — только чтение, нет side effects.

## Что НЕ входит

- Кастомизация engines в runtime
- Кэширование результатов
- Fallback на Brave если SearXNG недоступен
