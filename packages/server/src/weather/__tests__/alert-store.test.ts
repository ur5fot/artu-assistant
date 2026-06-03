import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb, closeDb } from '../../db.js';
import { createWeatherAlertStore } from '../alert-store.js';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

beforeEach(() => initDb(':memory:'));
afterEach(() => closeDb());

describe('createWeatherAlertStore', () => {
  describe('recordAlert + findRecentAlert', () => {
    it('records an alert and finds it within the window', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      const id = store.recordAlert('tempSwing:2026-06-04', T0);
      expect(id).toBeGreaterThan(0);

      const row = store.findRecentAlert('tempSwing:2026-06-04', T0 - 12 * HOUR);
      expect(row).not.toBeNull();
      expect(row!.event_key).toBe('tempSwing:2026-06-04');
      expect(row!.alerted_at).toBe(T0);
    });

    it('does not find an alert older than the since boundary', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.recordAlert('frost:2026-06-04', T0);

      // since is after the recorded alert → out of window
      const row = store.findRecentAlert('frost:2026-06-04', T0 + 1);
      expect(row).toBeNull();
    });

    it('finds an alert exactly at the since boundary (inclusive)', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.recordAlert('storm:2026-06-05', T0);

      const row = store.findRecentAlert('storm:2026-06-05', T0);
      expect(row).not.toBeNull();
    });

    it('scopes lookup by event_key (dedupe is per event)', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.recordAlert('tempSwing:2026-06-04', T0);

      expect(store.findRecentAlert('precip:2026-06-04', T0 - HOUR)).toBeNull();
      expect(store.findRecentAlert('tempSwing:2026-06-04', T0 - HOUR)).not.toBeNull();
    });

    it('returns the most recent alert when several exist for a key', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.recordAlert('frost:2026-06-04', T0);
      store.recordAlert('frost:2026-06-04', T0 + 6 * HOUR);

      const row = store.findRecentAlert('frost:2026-06-04', T0 - HOUR);
      expect(row!.alerted_at).toBe(T0 + 6 * HOUR);
    });
  });

  describe('lastCheckAt + setLastCheckAt', () => {
    it('returns null before any check is recorded', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      expect(store.lastCheckAt()).toBeNull();
    });

    it('round-trips the last check time', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.setLastCheckAt(T0);
      expect(store.lastCheckAt()).toBe(T0);
    });

    it('overwrites the previous check time (single-row state)', () => {
      const store = createWeatherAlertStore({ db: getDb() });
      store.setLastCheckAt(T0);
      store.setLastCheckAt(T0 + 3 * HOUR);
      expect(store.lastCheckAt()).toBe(T0 + 3 * HOUR);
    });
  });
});
