/**
 * ============================================================================
 * 檔案名稱：idbStore.js
 * 整體程式說明：
 *   PWA 本機 IndexedDB 儲存層（TripPwaDB v1），維持既有四個 Object Store 不擴充：
 *   1. baseline        : { key: 'current', meta, syncedAt, itinerary, pocket_spots, trip_meta }
 *   2. local_overrides : { activity_id, trip_date, fields: {...}, updatedAt }
 *   3. runtime_state   : { key, ... }（活動狀態、每日晴雨、當日停止旗標、當日插入備選景點）
 *   4. removed_history : { id, activity_id, trip_date, title_zh, removedAt, overrideFields, lastBaselineItem }
 *   另提供未發布變更檢查與單一 readwrite 交易覆蓋共享狀態，供多機同步服務使用。
 * ============================================================================
 */

const TripIdbStore = (() => {
  const DB_NAME = 'TripPwaDB';
  const DB_VERSION = 1;
  const BACKUP_VERSION = 1;
  const SUPPORTED_SCHEMA_VERSIONS = ['V1.2', 1, '1'];

  const STORES = {
    BASELINE: 'baseline',
    LOCAL_OVERRIDES: 'local_overrides',
    RUNTIME_STATE: 'runtime_state',
    REMOVED_HISTORY: 'removed_history'
  };

  const ALL_STORE_LIST = [
    STORES.BASELINE,
    STORES.LOCAL_OVERRIDES,
    STORES.RUNTIME_STATE,
    STORES.REMOVED_HISTORY
  ];

  let dbPromise = null;

  /**
   * 開啟並初始化 TripPwaDB 連線與既有四個 Object Store。
   * @return {Promise<IDBDatabase>}
   */
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

  /**
   * 將單一 IDBRequest 包裝為 Promise。
   * @param {IDBRequest} req
   * @return {Promise<*>}
   */
  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 操作失敗'));
    });
  }

  /**
   * 等待 IDBTransaction 完成或中止。
   * @param {IDBTransaction} tx
   * @return {Promise<void>}
   */
  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 交易失敗'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 交易中止'));
    });
  }

  // --- 第一層：baseline ---

  /**
   * 讀取目前本機保存的雲端底稿紀錄。
   * @return {Promise<Object|null>}
   */
  async function getBaseline() {
    const db = await openDb();
    const tx = db.transaction(STORES.BASELINE, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.BASELINE).get('current'));
    return rec || null;
  }

  /**
   * 儲存最新雲端底稿至 baseline store。
   * @param {Object} bundleData
   * @param {string=} syncedAtIso
   * @return {Promise<Object>}
   */
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

  /**
   * 讀取單一活動的本機覆寫紀錄。
   * @param {string} activityId
   * @return {Promise<Object|null>}
   */
  async function getOverride(activityId) {
    if (!activityId) return null;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.LOCAL_OVERRIDES).get(String(activityId)));
    return rec || null;
  }

  /**
   * 讀取全部本機欄位覆寫紀錄。
   * @return {Promise<Object[]>}
   */
  async function getAllOverrides() {
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readonly');
    return await reqToPromise(tx.objectStore(STORES.LOCAL_OVERRIDES).getAll());
  }

  /**
   * 更新指定活動的本機欄位覆寫（與既有覆寫欄位合併）。
   * @param {string} activityId
   * @param {string} tripDate
   * @param {Object} partialFields
   * @return {Promise<Object|null>}
   */
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
   * @param {string} activityId
   * @param {string} fieldName
   * @return {Promise<Object|null>}
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

  /**
   * 刪除指定活動的整筆本機覆寫紀錄。
   * @param {string} activityId
   * @return {Promise<void>}
   */
  async function deleteOverride(activityId) {
    if (!activityId) return;
    const db = await openDb();
    const tx = db.transaction(STORES.LOCAL_OVERRIDES, 'readwrite');
    tx.objectStore(STORES.LOCAL_OVERRIDES).delete(String(activityId));
    await txDone(tx);
  }

  // --- 第三層：runtime_state ---

  /**
   * 讀取單一 runtime_state 紀錄。
   * @param {string} key
   * @return {Promise<Object|null>}
   */
  async function getRuntimeItem(key) {
    if (!key) return null;
    const db = await openDb();
    const tx = db.transaction(STORES.RUNTIME_STATE, 'readonly');
    const rec = await reqToPromise(tx.objectStore(STORES.RUNTIME_STATE).get(String(key)));
    return rec || null;
  }

  /**
   * 寫入或更新單一 runtime_state 紀錄。
   * @param {Object} record
   * @return {Promise<void>}
   */
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

  /**
   * 讀取全部 runtime_state 紀錄。
   * @return {Promise<Object[]>}
   */
  async function getAllRuntimeItems() {
    const db = await openDb();
    const tx = db.transaction(STORES.RUNTIME_STATE, 'readonly');
    return await reqToPromise(tx.objectStore(STORES.RUNTIME_STATE).getAll());
  }

  /**
   * 取得活動執行狀態（pending / done / skipped）。
   * @param {string} activityId
   * @return {Promise<string>}
   */
  async function getActivityStatus(activityId) {
    const rec = await getRuntimeItem('act:' + String(activityId));
    return rec && rec.status ? rec.status : 'pending';
  }

  /**
   * 設定活動執行狀態。
   * @param {string} activityId
   * @param {string} status
   * @param {Object=} extraMeta
   * @return {Promise<void>}
   */
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

  /**
   * 取得指定日期的晴雨模式（sun / rain）。
   * @param {string} tripDate
   * @param {string=} fallbackMode
   * @return {Promise<string>}
   */
  async function getDayWeather(tripDate, fallbackMode) {
    const rec = await getRuntimeItem('weather:' + String(tripDate));
    if (rec && (rec.weather_mode === 'sun' || rec.weather_mode === 'rain')) {
      return rec.weather_mode;
    }
    return fallbackMode || 'sun';
  }

  /**
   * 設定指定日期的晴雨模式。
   * @param {string} tripDate
   * @param {string} weatherMode
   * @return {Promise<void>}
   */
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

  /**
   * 取得指定日期是否已標記「今天就到這裡」。
   * @param {string} tripDate
   * @return {Promise<boolean>}
   */
  async function getDayStopped(tripDate) {
    const rec = await getRuntimeItem('stop:' + String(tripDate));
    return !!(rec && rec.stopped === true);
  }

  /**
   * 設定指定日期的停止顯示旗標。
   * @param {string} tripDate
   * @param {boolean} stopped
   * @return {Promise<void>}
   */
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

  /**
   * 取得指定日期本機插入的備選景點清單。
   * @param {string} tripDate
   * @return {Promise<Object[]>}
   */
  async function getInsertedSpots(tripDate) {
    const rec = await getRuntimeItem('extra:' + String(tripDate));
    return rec && Array.isArray(rec.items) ? rec.items : [];
  }

  /**
   * 儲存指定日期本機插入的備選景點清單。
   * @param {string} tripDate
   * @param {Object[]} items
   * @return {Promise<void>}
   */
  async function saveInsertedSpots(tripDate, items) {
    await putRuntimeItem({
      key: 'extra:' + String(tripDate),
      type: 'inserted_spots',
      trip_date: String(tripDate),
      items: Array.isArray(items) ? items : []
    });
  }

  // --- 多機共享狀態輔助（未發布檢查與單一交易覆蓋） ---

  /**
   * 檢查本機是否有尚未發布或尚未被雲端進度對齊的本地修改。
   * 若 trip_pwa_has_unpublished 明確為 '0'，代表本機狀態已與雲端發布版對齊，直接回傳 false；
   * 僅在旗標為 '1' 或尚未建立旗標時才掃描 local_overrides 與 runtime_state。
   * @return {Promise<boolean>}
   */
  async function hasUnpublishedChanges() {
    if (typeof localStorage !== 'undefined') {
      const flag = localStorage.getItem('trip_pwa_has_unpublished');
      if (flag === '0') return false;
      if (flag === '1') return true;
    }

    const [overrides, runtimeItems] = await Promise.all([
      getAllOverrides(),
      getAllRuntimeItems()
    ]);

    const hasOv = Array.isArray(overrides) && overrides.some((ov) => {
      return ov && ov.activity_id && ov.fields && Object.keys(ov.fields).length > 0;
    });
    if (hasOv) return true;

    const hasRt = Array.isArray(runtimeItems) && runtimeItems.some((rt) => {
      if (!rt || !rt.key) return false;
      if (rt.type === 'activity_status') return rt.status && rt.status !== 'pending';
      if (rt.type === 'day_weather') return rt.weather_mode === 'rain';
      if (rt.type === 'day_stop') return rt.stopped === true;
      if (rt.type === 'inserted_spots') return Array.isArray(rt.items) && rt.items.length > 0;
      return true;
    });

    return hasRt;
  }

  /**
   * 在單一 readwrite transaction 中以雲端共享快照覆蓋本機 local_overrides 與 runtime_state。
   * 交易若失敗或中止會拋出例外，不會留下半套用狀態。
   * @param {{local_overrides: Object[], runtime_state: Object[]}} sharedState
   * @return {Promise<void>}
   */
  async function replaceSharedState(sharedState) {
    const ovList = (sharedState && Array.isArray(sharedState.local_overrides))
      ? sharedState.local_overrides
      : [];
    const rtList = (sharedState && Array.isArray(sharedState.runtime_state))
      ? sharedState.runtime_state
      : [];

    const db = await openDb();
    const tx = db.transaction([STORES.LOCAL_OVERRIDES, STORES.RUNTIME_STATE], 'readwrite');
    const ovStore = tx.objectStore(STORES.LOCAL_OVERRIDES);
    const rtStore = tx.objectStore(STORES.RUNTIME_STATE);

    ovStore.clear();
    rtStore.clear();

    ovList.forEach((ov) => {
      if (ov && ov.activity_id && ov.fields && typeof ov.fields === 'object') {
        ovStore.put({
          activity_id: String(ov.activity_id),
          trip_date: String(ov.trip_date || ''),
          fields: Object.assign({}, ov.fields),
          updatedAt: ov.updatedAt || new Date().toISOString()
        });
      }
    });

    rtList.forEach((rt) => {
      if (rt && rt.key) {
        rtStore.put(Object.assign({}, rt, {
          key: String(rt.key)
        }));
      }
    });

    await txDone(tx);
  }

  // --- 已移除項目歷史紀錄（removed_history） ---

  /**
   * 讀取全部已移除項目歷史紀錄（依移除時間由新到舊排序）。
   * @return {Promise<Object[]>}
   */
  async function getRemovedHistory() {
    const db = await openDb();
    const tx = db.transaction(STORES.REMOVED_HISTORY, 'readonly');
    const list = await reqToPromise(tx.objectStore(STORES.REMOVED_HISTORY).getAll());
    return list.sort((a, b) => String(b.removedAt || '').localeCompare(String(a.removedAt || '')));
  }

  /**
   * 新增一筆已移除項目歷史紀錄。
   * @param {Object} entry
   * @return {Promise<Object>}
   */
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

  /**
   * 清空已移除項目歷史紀錄。
   * @return {Promise<void>}
   */
  async function clearRemovedHistory() {
    const db = await openDb();
    const tx = db.transaction(STORES.REMOVED_HISTORY, 'readwrite');
    tx.objectStore(STORES.REMOVED_HISTORY).clear();
    await txDone(tx);
  }

  // --- 全部還原雲端底稿（保留 baseline 與 removed_history，清除 local_overrides 與 runtime_state） ---

  /**
   * 清除本機覆寫與執行狀態，還原顯示為目前本機保存的雲端底稿。
   * @return {Promise<void>}
   */
  async function restoreAllToBaseline() {
    const db = await openDb();
    const tx = db.transaction([STORES.LOCAL_OVERRIDES, STORES.RUNTIME_STATE], 'readwrite');
    tx.objectStore(STORES.LOCAL_OVERRIDES).clear();
    tx.objectStore(STORES.RUNTIME_STATE).clear();
    await txDone(tx);
  }

  // --- 完整備份匯出／匯入 ---

  /**
   * 匯出四個 Object Store 完整備份物件。
   * @return {Promise<Object>}
   */
  async function exportAllBackup() {
    const db = await openDb();
    const tx = db.transaction(ALL_STORE_LIST, 'readonly');
    const [baselineRec, overrides, runtimeItems, removedHistory] = await Promise.all([
      reqToPromise(tx.objectStore(STORES.BASELINE).get('current')),
      reqToPromise(tx.objectStore(STORES.LOCAL_OVERRIDES).getAll()),
      reqToPromise(tx.objectStore(STORES.RUNTIME_STATE).getAll()),
      reqToPromise(tx.objectStore(STORES.REMOVED_HISTORY).getAll())
    ]);
    await txDone(tx);

    const schemaVer = (baselineRec && baselineRec.meta && baselineRec.meta.schemaVersion)
      ? baselineRec.meta.schemaVersion
      : 'V1.2';

    return {
      backupVersion: BACKUP_VERSION,
      schemaVersion: schemaVer,
      exportedAt: new Date().toISOString(),
      data: {
        baseline: baselineRec || null,
        local_overrides: Array.isArray(overrides) ? overrides : [],
        runtime_state: Array.isArray(runtimeItems) ? runtimeItems : [],
        removed_history: Array.isArray(removedHistory) ? removedHistory : []
      }
    };
  }

  /**
   * 驗證匯入備份檔的版本與資料結構。
   * @param {*} payload
   * @return {string|null} 錯誤訊息，通過則回傳 null。
   */
  function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      return '備份檔案不是合法物件';
    }
    if (payload.backupVersion !== BACKUP_VERSION) {
      return '不支援的備份版本（backupVersion=' + String(payload.backupVersion) + '，僅支援 ' + BACKUP_VERSION + '）';
    }
    if (payload.schemaVersion === undefined || SUPPORTED_SCHEMA_VERSIONS.indexOf(payload.schemaVersion) === -1) {
      return '不支援的資料結構版本（schemaVersion=' + String(payload.schemaVersion) + '）';
    }
    const d = payload.data;
    if (!d || typeof d !== 'object') {
      return '備份檔案缺少 data 區塊';
    }
    if (d.baseline !== null && d.baseline !== undefined && typeof d.baseline !== 'object') {
      return 'data.baseline 格式無效';
    }
    if (!Array.isArray(d.local_overrides)) {
      return 'data.local_overrides 必須為陣列';
    }
    if (!Array.isArray(d.runtime_state)) {
      return 'data.runtime_state 必須為陣列';
    }
    if (!Array.isArray(d.removed_history)) {
      return 'data.removed_history 必須為陣列';
    }
    return null;
  }

  /**
   * 依備份檔完整覆蓋本機四個 Object Store。
   * @param {*} payload
   * @return {Promise<{ok: boolean, error?: string, message: string}>}
   */
  async function importAllBackup(payload) {
    const errMsg = validateBackupPayload(payload);
    if (errMsg) {
      return { ok: false, error: 'INVALID_BACKUP', message: errMsg };
    }

    const d = payload.data;
    const db = await openDb();
    const tx = db.transaction(ALL_STORE_LIST, 'readwrite');

    try {
      const baseStore = tx.objectStore(STORES.BASELINE);
      const ovStore = tx.objectStore(STORES.LOCAL_OVERRIDES);
      const rtStore = tx.objectStore(STORES.RUNTIME_STATE);
      const remStore = tx.objectStore(STORES.REMOVED_HISTORY);

      baseStore.clear();
      ovStore.clear();
      rtStore.clear();
      remStore.clear();

      if (d.baseline && typeof d.baseline === 'object') {
        baseStore.put(Object.assign({}, d.baseline, { key: 'current' }));
      }
      d.local_overrides.forEach((item) => {
        if (item && item.activity_id) {
          ovStore.put(item);
        }
      });
      d.runtime_state.forEach((item) => {
        if (item && item.key) {
          rtStore.put(item);
        }
      });
      d.removed_history.forEach((item) => {
        if (item && item.id) {
          remStore.put(item);
        }
      });

      await txDone(tx);
      return { ok: true, message: '已完整匯入備份並覆蓋本機四個資料區' };
    } catch (e) {
      return {
        ok: false,
        error: 'IMPORT_FAILED',
        message: '備份匯入失敗，已中止寫入（' + (e && e.message ? e.message : String(e)) + '）'
      };
    }
  }

  return {
    DB_NAME,
    DB_VERSION,
    BACKUP_VERSION,
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
    hasUnpublishedChanges,
    replaceSharedState,
    getRemovedHistory,
    addRemovedHistoryItem,
    clearRemovedHistory,
    restoreAllToBaseline,
    exportAllBackup,
    validateBackupPayload,
    importAllBackup
  };
})();
if (typeof TripIdbStore !== 'undefined') window.TripIdbStore = TripIdbStore;
