/**
 * idbStore.js
 * PWA 本機 IndexedDB 儲存層（TripPwaDB v1）
 * 四個 Object Store：
 *   1. baseline        : { key: 'current', meta, syncedAt, itinerary, pocket_spots, trip_meta }
 *   2. local_overrides : { activity_id, trip_date, fields: {...}, updatedAt }
 *   3. runtime_state   : { key, ... }（支援活動狀態、每日晴雨、當日停止旗標、當日插入備選景點）
 *   4. removed_history : { id, activity_id, trip_date, title_zh, removedAt, overrideFields, lastBaselineItem }
 */

const TripIdbStore = (() => {
  const DB_NAME = 'TripPwaDB';
  const DB_VERSION = 1;

  const STORES = {
    BASELINE: 'baseline',
    LOCAL_OVERRIDES: 'local_overrides',
    RUNTIME_STATE: 'runtime_state',
    REMOVED_HISTORY: 'removed_history'
  };

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('此環境不支援 IndexedDB'));
        return;
      }

      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(STORES.BASELINE)) {
          db.createObjectStore(STORES.BASELINE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.LOCAL_OVERRIDES)) {
          const ovStore = db.createObjectStore(STORES.LOCAL_OVERRIDES, { keyPath: 'activity_id' });
          ovStore.createIndex('trip_date', 'trip_date', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORES.RUNTIME_STATE)) {
          db.createObjectStore(STORES.RUNTIME_STATE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORES.REMOVED_HISTORY)) {
          const remStore = db.createObjectStore(STORES.REMOVED_HISTORY, { keyPath: 'id' });
          remStore.createIndex('activity_id', 'activity_id', { unique: false });
          remStore.createIndex('removedAt', 'removedAt', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error || new Error('開啟 TripPwaDB 失敗'));
      };
    });

    return dbPromise;
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 操作失敗'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 交易失敗'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 交易中止'));
    });
  }

  // --- 第一層：baseline ---

  async function getBaseline() {
    const db = await openDb();
    const tx = db.transaction(STORES.BASELINE, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.BASELINE).get('current'));
    return rec || null;
  }

  async function saveBaseline(bundleData, syncedAtIso) {
    const db = await openDb();
    const tx = db.transaction(STORES.BASELINE, 'readwrite');
    const record = {
      key: 'current',
      meta: bundleData.meta || {},
      syncedAt: syncedAtIso || new Date().toISOString(),
      itinerary: Array.isArray(bundleData.itinerary) ? bundleData.itinerary : [],
      pocket_spots: Array.isArray(bundleData.pocket_spots) ? bundleData.pocket_spots : [],
      trip_meta: Array.isArray(bundleData.trip_meta) ? bundleData.trip_meta : []
    };
    tx.objectStore(STORES.BASELINE).put(record);
    await txDone(tx);
    return record;
  }

  // --- 第二層：local_overrides（依 activity_id 與欄位層級覆寫） ---

  async function getOverride(activityId) {
    if (!activityId) return null;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.LOCAL_OVERRIDES).get(String(activityId)));
    return rec || null;
  }

  async function getAllOverrides() {
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readonly');
    return await reqToPromise(tx.objectStore(STORES.LOCAL_OVERRIDES).getAll());
  }

  async function setFieldOverrides(activityId, tripDate, partialFields) {
    if (!activityId || !partialFields || typeof partialFields !== 'object') return null;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readwrite');
    const store = tx.objectStore(STORES.LOCAL_OVERRIDES);
    const existing = await reqToPromise(store.get(String(activityId)));

    const mergedFields = Object.assign({}, existing && existing.fields ? existing.fields : {});
    Object.keys(partialFields).forEach((k) => {
      if (partialFields[k] !== undefined) {
        mergedFields[k] = partialFields[k];
      }
    });

    const nextRec = {
      activity_id: String(activityId),
      trip_date: tripDate || (existing ? existing.trip_date : ''),
      fields: mergedFields,
      updatedAt: new Date().toISOString()
    };
    store.put(nextRec);
    await txDone(tx);
    return nextRec;
  }

  /**
   * 僅還原指定活動的指定欄位（刪除該欄位 override）；若無剩餘覆寫欄位則移除整筆 override。
   */
  async function clearFieldOverride(activityId, fieldName) {
    if (!activityId || !fieldName) return null;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readwrite');
    const store = tx.objectStore(STORES.LOCAL_OVERRIDES);
    const existing = await reqToPromise(store.get(String(activityId)));
    if (!existing || !existing.fields) {
      await txDone(tx);
      return null;
    }

    const nextFields = Object.assign({}, existing.fields);
    delete nextFields[fieldName];

    if (Object.keys(nextFields).length === 0) {
      store.delete(String(activityId));
      await txDone(tx);
      return null;
    }

    const nextRec = {
      activity_id: existing.activity_id,
      trip_date: existing.trip_date,
      fields: nextFields,
      updatedAt: new Date().toISOString()
    };
    store.put(nextRec);
    await txDone(tx);
    return nextRec;
  }

  async function deleteOverride(activityId) {
    if (!activityId) return;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readwrite');
    tx.objectStore(STORES.LOCAL_OVERRIDES).delete(String(activityId));
    await txDone(tx);
  }

  // --- 第三層：runtime_state ---

  async function getRuntimeItem(key) {
    if (!key) return null;
    const db = await openDb();
    const tx = db.transaction(STORES.RUNTIME_STATE, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.RUNTIME_STATE).get(String(key)));
    return rec || null;
  }

  async function putRuntimeItem(record) {
    if (!record || !record.key) throw new Error('runtime_state 紀錄缺少 key');
    const db = await openDb();
    const tx = db.transaction(STORES.RUNTIME_STATE, 'readwrite');
    tx.objectStore(STORES.RUNTIME_STATE).put(Object.assign({}, record, {
      key: String(record.key),
      updatedAt: new Date().toISOString()
    }));
    await txDone(tx);
  }

  async function getAllRuntimeItems() {
    const db = await openDb();
    const tx = db.transaction(STORES.RUNTIME_STATE, 'readonly');
    return await reqToPromise(tx.objectStore(STORES.RUNTIME_STATE).getAll());
  }

  // 活動執行狀態（'pending' | 'done' | 'skipped'），依 activity_id 獨立保存
  async function getActivityStatus(activityId) {
    const rec = await getRuntimeItem('act:' + String(activityId));
    return rec && rec.status ? rec.status : 'pending';
  }

  async function setActivityStatus(activityId, status, extraMeta) {
    const valid = ['pending', 'done', 'skipped'];
    if (valid.indexOf(status) === -1) {
      throw new Error('無效的活動狀態：' + status);
    }
    await putRuntimeItem(Object.assign({
      key: 'act:' + String(activityId),
      type: 'activity_status',
      activity_id: String(activityId),
      status: status
    }, extraMeta || {}));
  }

  // 每日晴雨模式（'sun' | 'rain'）
  async function getDayWeather(tripDate, fallbackMode) {
    const rec = await getRuntimeItem('weather:' + String(tripDate));
    if (rec && (rec.weather_mode === 'sun' || rec.weather_mode === 'rain')) {
      return rec.weather_mode;
    }
    return fallbackMode || 'sun';
  }

  async function setDayWeather(tripDate, weatherMode) {
    if (weatherMode !== 'sun' && weatherMode !== 'rain') {
      throw new Error('每日晴雨模式僅允許 sun 或 rain');
    }
    await putRuntimeItem({
      key: 'weather:' + String(tripDate),
      type: 'day_weather',
      trip_date: String(tripDate),
      weather_mode: weatherMode
    });
  }

  // 當日「今天就到這裡」旗標（只停止顯示當日剩餘待執行行程，未執行維持 pending、不改 skipped、不影響隔日）
  async function getDayStopped(tripDate) {
    const rec = await getRuntimeItem('stop:' + String(tripDate));
    return !!(rec && rec.stopped === true);
  }

  async function setDayStopped(tripDate, stopped) {
    const isStopped = Boolean(stopped);
    await putRuntimeItem({
      key: 'stop:' + String(tripDate),
      type: 'day_stop',
      trip_date: String(tripDate),
      stopped: isStopped,
      stoppedAt: isStopped ? new Date().toISOString() : null
    });
  }

  // 當日插入之備選站點清單（保存完整快照、錨點 after_activity_id、停留與交通）
  async function getInsertedSpots(tripDate) {
    const rec = await getRuntimeItem('extra:' + String(tripDate));
    return rec && Array.isArray(rec.items) ? rec.items : [];
  }

  async function saveInsertedSpots(tripDate, items) {
    await putRuntimeItem({
      key: 'extra:' + String(tripDate),
      type: 'inserted_spots',
      trip_date: String(tripDate),
      items: Array.isArray(items) ? items : []
    });
  }

  // --- 已移除項目歷史紀錄（removed_history） ---

  async function getRemovedHistory() {
    const db = await openDb();
    const tx = db.transaction(STORES.REMOVED_HISTORY, 'readonly');
    const list = await reqToPromise(tx.objectStore(STORES.REMOVED_HISTORY).getAll());
    return list.sort((a, b) => String(b.removedAt || '').localeCompare(String(a.removedAt || '')));
  }

  async function addRemovedHistoryItem(entry) {
    const db = await openDb();
    const tx = db.transaction(STORES.REMOVED_HISTORY, 'readwrite');
    const id = entry.id || ('REM-' + String(entry.activity_id) + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const rec = Object.assign({}, entry, {
      id: id,
      removedAt: entry.removedAt || new Date().toISOString()
    });
    tx.objectStore(STORES.REMOVED_HISTORY).put(rec);
    await txDone(tx);
    return rec;
  }

  async function clearRemovedHistory() {
    const db = await openDb();
    const tx = db.transaction(STORES.REMOVED_HISTORY, 'readwrite');
    tx.objectStore(STORES.REMOVED_HISTORY).clear();
    await txDone(tx);
  }

  return {
    DB_NAME,
    DB_VERSION,
    STORES,
    openDb,
    getBaseline,
    saveBaseline,
    getOverride,
    getAllOverrides,
    setFieldOverrides,
    clearFieldOverride,
    deleteOverride,
    getRuntimeItem,
    putRuntimeItem,
    getAllRuntimeItems,
    getActivityStatus,
    setActivityStatus,
    getDayWeather,
    setDayWeather,
    getDayStopped,
    setDayStopped,
    getInsertedSpots,
    saveInsertedSpots,
    getRemovedHistory,
    addRemovedHistoryItem,
    clearRemovedHistory
  };
})();
