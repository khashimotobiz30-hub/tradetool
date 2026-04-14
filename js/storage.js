// ============================================================
// storage.js — localStorage ラッパー
// ============================================================

const Storage = (() => {

  function save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.error('[Storage] save failed', key, e);
    }
  }

  function load(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error('[Storage] load failed', key, e);
      return fallback;
    }
  }

  function remove(key) {
    localStorage.removeItem(key);
  }

  // --- セッション (当日) ---
  function saveSession(session) {
    save(CFG.STORAGE_KEY_SESSION, session);
  }

  function loadSession() {
    const s = load(CFG.STORAGE_KEY_SESSION, null);
    // 日付が変わっていたらリセット
    if (s && s.date !== todayStr()) return null;
    return s;
  }

  // --- 日次履歴 ---
  function saveDayRecord(record) {
    const days = load(CFG.STORAGE_KEY_DAYS, {});
    days[record.date] = record;
    save(CFG.STORAGE_KEY_DAYS, days);
  }

  function loadDayRecord(dateStr) {
    const days = load(CFG.STORAGE_KEY_DAYS, {});
    return days[dateStr] || null;
  }

  function loadAllDayRecords() {
    return load(CFG.STORAGE_KEY_DAYS, {});
  }

  // --- イベントログ ---
  function appendEvent(event) {
    const key = CFG.STORAGE_KEY_EVENTS + '_' + todayStr();
    const events = load(key, []);
    events.push(event);
    save(key, events);
  }

  function loadTodayEvents() {
    const key = CFG.STORAGE_KEY_EVENTS + '_' + todayStr();
    return load(key, []);
  }

  function loadEventsForDate(dateStr) {
    const key = CFG.STORAGE_KEY_EVENTS + '_' + dateStr;
    return load(key, []);
  }

  // --- アプリ状態 ---
  function saveAppState(state) {
    save(CFG.STORAGE_KEY_STATE, state);
  }

  function loadAppState() {
    return load(CFG.STORAGE_KEY_STATE, null);
  }

  // --- ユーティリティ ---
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function generateId(prefix) {
    return prefix + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14) +
      String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  }

  return {
    saveSession, loadSession,
    saveDayRecord, loadDayRecord, loadAllDayRecords,
    appendEvent, loadTodayEvents, loadEventsForDate,
    saveAppState, loadAppState,
    todayStr, generateId,
  };
})();
