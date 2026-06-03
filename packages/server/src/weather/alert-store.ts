import type Database from 'better-sqlite3';

export interface WeatherAlertRow {
  id: number;
  event_key: string;
  alerted_at: number;
}

export interface WeatherAlertStore {
  /** Record that an alert for `key` was published at `at`, returning its id. */
  recordAlert(key: string, at: number): number;
  /** Most recent alert for `key` published at or after `since`, else null. */
  findRecentAlert(key: string, since: number): WeatherAlertRow | null;
  /** Last time the weatherAlert handler ran a check, or null if never. */
  lastCheckAt(): number | null;
  /** Persist the last check time (single-row state). */
  setLastCheckAt(at: number): void;
}

const COLUMNS = 'id, event_key, alerted_at';
const LAST_CHECK_KEY = 'weather_alert_last_check_at';

export function createWeatherAlertStore(deps: { db: Database.Database }): WeatherAlertStore {
  const { db } = deps;

  const insertAlert = db.prepare(
    `INSERT INTO weather_alerts (event_key, alerted_at) VALUES (?, ?)`,
  );
  const selectRecentAlert = db.prepare(
    `SELECT ${COLUMNS} FROM weather_alerts
     WHERE event_key = ? AND alerted_at >= ?
     ORDER BY alerted_at DESC, id DESC
     LIMIT 1`,
  );
  const selectMeta = db.prepare(`SELECT value FROM weather_meta WHERE key = ?`);
  const upsertMeta = db.prepare(
    `INSERT INTO weather_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  return {
    recordAlert(key, at) {
      const info = insertAlert.run(key, at);
      return Number(info.lastInsertRowid);
    },

    findRecentAlert(key, since) {
      const row = selectRecentAlert.get(key, since) as WeatherAlertRow | undefined;
      return row ?? null;
    },

    lastCheckAt() {
      const row = selectMeta.get(LAST_CHECK_KEY) as { value: number } | undefined;
      return row?.value ?? null;
    },

    setLastCheckAt(at) {
      upsertMeta.run(LAST_CHECK_KEY, at);
    },
  };
}
