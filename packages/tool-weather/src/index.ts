import type { ToolDefinition, ToolResult } from '@r2/shared';
import type {
  Coords,
  Forecast,
  ResolveUserCoordsFn,
  WeatherClientLike,
} from './types.js';

export type {
  Coords,
  DayForecast,
  Forecast,
  GeocodeResult,
  HourForecast,
  ResolveUserCoordsFn,
  WeatherClientLike,
} from './types.js';

interface Deps {
  weatherClient: WeatherClientLike | null;
  resolveUserCoords: ResolveUserCoordsFn | null;
}

/** Structural per-day projection (raw numbers + RU weather description). */
function toDayData(client: WeatherClientLike, forecast: Forecast) {
  return forecast.days.map((d) => ({
    date: d.date,
    temp_min: Math.round(d.tempMin),
    temp_max: Math.round(d.tempMax),
    precip_prob: d.precipProbMax,
    weather_code: d.weatherCode,
    weather_ru: client.wmoToRu(d.weatherCode),
    wind_max: Math.round(d.windMax),
  }));
}

function forecastResult(
  client: WeatherClientLike,
  locationName: string,
  forecast: Forecast,
): ToolResult {
  return {
    success: true,
    data: {
      location: { name: locationName, lat: forecast.lat, lon: forecast.lon },
      tz: forecast.tz,
      summary: client.formatBriefOutlook(forecast),
      days: toDayData(client, forecast),
    },
  };
}

function createWeatherTool(deps: Deps): ToolDefinition {
  return {
    name: 'weather',
    description:
      'Прогноз погоды на 3 дня через Open-Meteo. Без параметров — погода в городе юзера ' +
      '(по сохранённым координатам). С `location` — погода в указанном городе. ' +
      'Используй когда юзер спрашивает «какая погода», «что там на улице», «погода в <город>», ' +
      '«брать ли зонт». Возвращает структурный прогноз (по дням) + готовую RU-сводку.',
    permissionLevel: 'auto',
    provider: 'all',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Город/место (опционально). Без него — координаты юзера.',
        },
      },
    },
    command: {
      name: 'погода',
      description: 'Прогноз на 3 дня',
      params: [{ name: 'location', required: false, description: 'Город (опц.)' }],
    },
    async handler(params: Record<string, unknown>): Promise<ToolResult> {
      const { weatherClient, resolveUserCoords } = deps;
      if (!weatherClient) {
        return { success: false, error: 'Weather integration is not enabled on this server' };
      }

      const rawLocation = typeof params.location === 'string' ? params.location.trim() : '';

      try {
        if (rawLocation) {
          const hit = await weatherClient.geocode(rawLocation);
          if (!hit) {
            return { success: false, error: `Не нашёл город «${rawLocation}»` };
          }
          const name = hit.admin1 ? `${hit.name}, ${hit.admin1}` : hit.name;
          const forecast = await weatherClient.fetchForecast(hit.lat, hit.lon, weatherClient.tz);
          return forecastResult(weatherClient, name, forecast);
        }

        if (!resolveUserCoords) {
          return { success: false, error: 'Координаты пользователя не настроены' };
        }
        const coords: Coords | null = await resolveUserCoords();
        if (!coords) {
          return {
            success: false,
            error: 'Координаты пользователя не настроены (укажи город или WEATHER_LAT/LON)',
          };
        }
        const forecast = await weatherClient.fetchForecast(coords.lat, coords.lon, weatherClient.tz);
        return forecastResult(weatherClient, coords.city, forecast);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export function createTool(deps: Deps): ToolDefinition[] {
  return [createWeatherTool(deps)];
}

export default createTool;
