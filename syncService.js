/**
 * ============================================================================
 * 檔案名稱：syncService.js
 * 整體程式說明：
 *   PWA 雲端同步與主控發布協調層，負責：
 *   1. syncFromCloud()：呼叫 GAS GET 同步底稿（baseline），處理移除項目移入 removed_history，
 *      並回傳最新底稿與雲端 liveState 摘要。
 *   2. pullLiveState()：拉取雲端共享進度快照（liveState），比對 baselineVersion（不同則先同步底稿），
 *      若有未發布修改則先徵求確認再單一交易覆蓋，並清除 hasUnpublished 旗標避免重複誤判。
 *   3. pushLiveState() 與 10 秒延遲自動發布（scheduleAutoPublish / clearAutoPublishTimer）：
 *      以 text/plain POST 送出發布請求，完成後透過 onAutoPublishDone 通知 UI 即時刷新紅點與版號。
 *   4. 同步工作鎖（IDLE / AUTO_PUBLISH / MANUAL_PUBLISH / PULL）：
 *      防止自動發布與手動拉取同時進行造成狀態交錯，並於 finally 嚴格釋放鎖定。
 * ============================================================================
 */

const TripSyncService = (() => {
  const LIVE_META_KEYS = {
    REVISION: 'trip_pwa_live_revision',
    BASELINE_VERSION: 'trip_pwa_live_baseline_version',
    PUBLISHED_BY_DEVICE_ID: 'trip_pwa_live_published_by_device_id',
    PUBLISHED_BY_NAME: 'trip_pwa_live_published_by_name',
    PUBLISHED_AT: 'trip_pwa_live_published_at',
    HAS_UNPUBLISHED: 'trip_pwa_has_unpublished'
  };

  const LOCK_STATES = {
    IDLE: 'IDLE',
    AUTO_PUBLISH: 'AUTO_PUBLISH',
    MANUAL_PUBLISH: 'MANUAL_PUBLISH',
    PULL: 'PULL'
  };

  const AUTO_PUBLISH_DELAY_MS = 10000;

  let currentLock = LOCK_STATES.IDLE;
  let autoPublishTimer = null;
  let pendingAutoPublishResolver = null;

  /**
   * 取得目前同步工作鎖狀態。
   * @return {string}
   */
  function getLockState() {
    return currentLock;
  }

  /**
   * 嘗試取得同步工作鎖；若目前已有其他同步作業進行則回傳 false。
   * @param {string} targetState
   * @return {boolean}
   */
  function acquireSyncLock(targetState) {
    if (currentLock !== LOCK_STATES.IDLE) {
      return false;
    }
    currentLock = targetState;
    return true;
  }

  /**
   * 釋放同步工作鎖回 IDLE。
   */
  function releaseSyncLock() {
    currentLock = LOCK_STATES.IDLE;
  }

  /**
   * 清除尚未觸發的 10 秒延遲自動發布計時器。
   */
  function clearAutoPublishTimer() {
    if (autoPublishTimer !== null) {
      clearTimeout(autoPublishTimer);
      autoPublishTimer = null;
    }
    if (typeof pendingAutoPublishResolver === 'function') {
      const resolve = pendingAutoPublishResolver;
      pendingAutoPublishResolver = null;
      resolve({ ok: false, error: 'CANCELLED', message: '已取消排程中的自動發布' });
    }
  }

  /**
   * 讀取本機記錄的共享版號、主控者中繼資訊與未發布旗標。
   * @return {Object}
   */
  function getLiveSyncMeta() {
    const revRaw = localStorage.getItem(LIVE_META_KEYS.REVISION) || '0';
    const parsedRev = parseInt(revRaw, 10);
    return {
      revision: (!isNaN(parsedRev) && parsedRev >= 0) ? parsedRev : 0,
      baselineVersion: localStorage.getItem(LIVE_META_KEYS.BASELINE_VERSION) || '',
      publishedByDeviceId: localStorage.getItem(LIVE_META_KEYS.PUBLISHED_BY_DEVICE_ID) || '',
      publishedByName: localStorage.getItem(LIVE_META_KEYS.PUBLISHED_BY_NAME) || '',
      publishedAt: localStorage.getItem(LIVE_META_KEYS.PUBLISHED_AT) || '',
      hasUnpublished: localStorage.getItem(LIVE_META_KEYS.HAS_UNPUBLISHED) === '1'
    };
  }

  /**
   * 寫入本機記錄的共享版號與主控者中繼資訊。
   * @param {Object} meta
   */
  function saveLiveSyncMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    if (meta.revision !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.REVISION, String(Math.max(0, Number(meta.revision) || 0)));
    }
    if (meta.baselineVersion !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.BASELINE_VERSION, String(meta.baselineVersion || ''));
    }
    if (meta.publishedByDeviceId !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.PUBLISHED_BY_DEVICE_ID, String(meta.publishedByDeviceId || '').trim());
    }
    if (meta.publishedByName !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.PUBLISHED_BY_NAME, String(meta.publishedByName || '').trim());
    }
    if (meta.publishedAt !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.PUBLISHED_AT, String(meta.publishedAt || ''));
    }
    if (meta.hasUnpublished !== undefined) {
      localStorage.setItem(LIVE_META_KEYS.HAS_UNPUBLISHED, meta.hasUnpublished ? '1' : '0');
    }
  }

  /**
   * 標記本機有尚未發布的修改，並於主控模式下啟動 10 秒延遲自動發布。
   * @param {Object} opts
   */
  function notifyLocalChange(opts) {
    saveLiveSyncMeta({ hasUnpublished: true });
    const cfg = opts || {};
    if (cfg.role === 'host') {
      scheduleAutoPublish(cfg);
    }
  }

  /**
   * 排程 10 秒延遲自動發布（debounce：若在 10 秒內再次修改則重新計時），
   * 完成後若呼叫端提供 onAutoPublishDone 回呼則立即通知更新 UI。
   * @param {Object} opts
   */
  function scheduleAutoPublish(opts) {
    clearAutoPublishTimer();
    const baseOpts = opts || {};
    const onDone = (typeof baseOpts.onAutoPublishDone === 'function') ? baseOpts.onAutoPublishDone : null;
    const snapshotOpts = Object.assign({}, baseOpts, {
      isAuto: true,
      allowHostTakeover: false
    });

    autoPublishTimer = setTimeout(async () => {
      autoPublishTimer = null;
      const resolver = pendingAutoPublishResolver;
      pendingAutoPublishResolver = null;
      const res = await pushLiveState(snapshotOpts);
      if (onDone) {
        await onDone(res);
      }
      if (typeof resolver === 'function') {
        resolver(res);
      }
    }, AUTO_PUBLISH_DELAY_MS);
  }

  /**
   * 建構 GET 同步底稿／讀取狀態的完整 URL。
   * @param {string} endpointUrl
   * @param {string} token
   * @return {string}
   */
  function buildSyncUrl(endpointUrl, token) {
    const cleanUrl = String(endpointUrl || '').trim();
    const cleanToken = String(token || '').trim();
    if (!cleanUrl) {
      throw new Error('尚未設定 GAS Web App 網址');
    }
    if (!cleanToken) {
      throw new Error('尚未設定 READ_TOKEN');
    }
    const sep = cleanUrl.indexOf('?') === -1 ? '?' : '&';
    return cleanUrl + sep + 'token=' + encodeURIComponent(cleanToken);
  }

  /**
   * 驗證 06_Api.gs 回傳的底稿資料包結構是否完整。
   * @param {Object} data
   * @return {string|null}
   */
  function validateRemoteData(data) {
    if (!data || typeof data !== 'object') {
      return '回傳 data 結構無效';
    }
    if (!Array.isArray(data.itinerary) || !Array.isArray(data.pocket_spots) || !Array.isArray(data.trip_meta)) {
      return '回傳缺少 itinerary、pocket_spots 或 trip_meta 陣列';
    }
    return null;
  }

  /**
   * 執行 GET 請求並解析 JSON 回應。
   * @param {string} url
   * @param {number} timeoutMs
   * @return {Promise<{ok: boolean, error?: string, message?: string, json?: Object}>}
   * @private
   */
  async function fetchGetJson_(url, timeoutMs) {
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let rawText = '';

    try {
      const resp = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      rawText = await resp.text();
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      return {
        ok: false,
        error: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: isAbort
          ? '連線逾時，已保留本機既有資料不變'
          : '目前處於離線或無法連線至雲端，已保留本機既有資料不變'
      };
    } finally {
      if (timer) clearTimeout(timer);
    }

    let json;
    try {
      json = JSON.parse(rawText);
    } catch (e) {
      return {
        ok: false,
        error: 'BAD_JSON',
        message: '雲端回應非合法 JSON，已保留本機既有資料不變'
      };
    }

    if (!json || json.ok !== true) {
      return {
        ok: false,
        error: (json && json.error) ? json.error : 'SYNC_REJECTED',
        message: (json && json.message) ? json.message : '雲端拒絕請求，已保留本機既有資料不變'
      };
    }

    return { ok: true, json: json };
  }

  /**
   * 將雲端回傳的底稿寫入 baseline，並將「雲端已刪除但本機曾修改」的活動移入 removed_history。
   * @param {Object} remoteData
   * @param {Object|null} prevBaseline
   * @param {string} nowIso
   * @return {Promise<{savedBaseline: Object, movedToHistoryCount: number}>}
   * @private
   */
  async function applyRemoteBaseline_(remoteData, prevBaseline, nowIso) {
    const newActIdSet = new Set(
      remoteData.itinerary.map((item) => String(item.activity_id || '').trim()).filter(Boolean)
    );
    const prevActMap = new Map();
    if (prevBaseline && Array.isArray(prevBaseline.itinerary)) {
      prevBaseline.itinerary.forEach((item) => {
        if (item.activity_id) prevActMap.set(String(item.activity_id).trim(), item);
      });
    }

    const currentOverrides = await TripIdbStore.getAllOverrides();
    let movedToHistoryCount = 0;

    for (const ov of currentOverrides) {
      const actId = String(ov.activity_id || '').trim();
      if (!actId) continue;

      if (!newActIdSet.has(actId)) {
        const lastBase = prevActMap.get(actId) || null;
        await TripIdbStore.addRemovedHistoryItem({
          activity_id: actId,
          trip_date: ov.trip_date || (lastBase ? lastBase.trip_date : ''),
          title_zh: (ov.fields && ov.fields.title_zh) || (lastBase ? lastBase.title_zh : actId),
          removedAt: nowIso,
          overrideFields: Object.assign({}, ov.fields || {}),
          lastBaselineItem: lastBase
        });
        await TripIdbStore.deleteOverride(actId);
        movedToHistoryCount++;
      }
    }

    const savedBaseline = await TripIdbStore.saveBaseline(remoteData, nowIso);
    return { savedBaseline, movedToHistoryCount };
  }

  /**
   * 手動同步雲端底稿（baseline），同時同步取得雲端 liveState 摘要。
   * @param {{endpointUrl: string, token: string, timeoutMs?: number}} opts
   * @return {Promise<Object>}
   */
  async function syncFromCloud(opts) {
    const timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 20000;
    let url;
    try {
      url = buildSyncUrl(opts && opts.endpointUrl, opts && opts.token);
    } catch (e) {
      return { ok: false, error: 'CONFIG_MISSING', message: e.message };
    }

    if (!acquireSyncLock(LOCK_STATES.PULL)) {
      return { ok: false, error: 'SYNC_BUSY', message: '目前有同步作業正在進行，請稍後再試' };
    }

    try {
      const prevBaseline = await TripIdbStore.getBaseline();
      const netRes = await fetchGetJson_(url, timeoutMs);
      if (!netRes.ok) {
        return { ok: false, error: netRes.error, message: netRes.message };
      }

      const json = netRes.json;
      const schemaErr = validateRemoteData(json.data);
      if (schemaErr) {
        return {
          ok: false,
          error: 'SCHEMA_INVALID',
          message: schemaErr + '，已保留本機既有底稿不變'
        };
      }

      const nowIso = new Date().toISOString();
      const applied = await applyRemoteBaseline_(json.data, prevBaseline, nowIso);

      const liveState = (json.liveState && typeof json.liveState === 'object') ? json.liveState : null;
      if (liveState && typeof liveState.revision === 'number') {
        saveLiveSyncMeta({
          revision: liveState.revision,
          baselineVersion: liveState.baselineVersion || '',
          publishedByDeviceId: liveState.publishedByDeviceId || '',
          publishedByName: liveState.publishedByName || '',
          publishedAt: liveState.publishedAt || ''
        });
      }

      return {
        ok: true,
        message: '已同步最新雲端底稿' + (applied.movedToHistoryCount > 0 ? `（${applied.movedToHistoryCount} 筆雲端已移除且曾修改的活動已移至歷史紀錄）` : ''),
        movedToHistoryCount: applied.movedToHistoryCount,
        baseline: applied.savedBaseline,
        liveState: liveState
      };
    } finally {
      releaseSyncLock();
    }
  }

  /**
   * 拉取雲端共享進度快照（liveState）：
   * 1. 先取得遠端底稿與 liveState；若雲端 baselineVersion 與本機不同，先同步底稿。
   * 2. 僅在「本機確實有尚未發布之本地變更」時才呼叫 confirmOverwrite 徵求確認；取消則完全不動本機資料。
   * 3. 確認後以單一 readwrite 交易覆蓋本機 local_overrides 與 runtime_state，並明確將 hasUnpublished 設為 false。
   * @param {{endpointUrl: string, token: string, timeoutMs?: number, confirmOverwrite?: Function}} opts
   * @return {Promise<Object>}
   */
  async function pullLiveState(opts) {
    clearAutoPublishTimer();
    const timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 20000;
    const confirmOverwrite = (opts && typeof opts.confirmOverwrite === 'function')
      ? opts.confirmOverwrite
      : async () => window.confirm('本機目前有尚未發布的修改，拉取雲端進度會覆蓋本機未發布的微調與狀態，是否繼續？');

    let url;
    try {
      url = buildSyncUrl(opts && opts.endpointUrl, opts && opts.token);
    } catch (e) {
      return { ok: false, error: 'CONFIG_MISSING', message: e.message };
    }

    if (!acquireSyncLock(LOCK_STATES.PULL)) {
      return { ok: false, error: 'SYNC_BUSY', message: '目前有發布或同步作業進行中，請稍後再試' };
    }

    try {
      const prevBaseline = await TripIdbStore.getBaseline();
      const netRes = await fetchGetJson_(url, timeoutMs);
      if (!netRes.ok) {
        return { ok: false, error: netRes.error, message: netRes.message };
      }

      const json = netRes.json;
      const schemaErr = validateRemoteData(json.data);
      if (schemaErr) {
        return {
          ok: false,
          error: 'SCHEMA_INVALID',
          message: schemaErr + '，已保留本機既有資料不變'
        };
      }

      const liveState = (json.liveState && typeof json.liveState === 'object') ? json.liveState : null;
      if (!liveState || typeof liveState.revision !== 'number' || liveState.revision === 0) {
        return {
          ok: false,
          error: 'NO_LIVE_STATE',
          message: '雲端尚無已發布的共享進度'
        };
      }

      const localMeta = getLiveSyncMeta();
      const hasLocalDiff = localMeta.hasUnpublished || await TripIdbStore.hasUnpublishedChanges();

      if (hasLocalDiff) {
        const agreed = await confirmOverwrite(liveState, localMeta);
        if (!agreed) {
          return {
            ok: false,
            error: 'USER_CANCELLED',
            message: '已取消拉取，保留本機既有修改不變'
          };
        }
      }

      const remoteBaseVer = String((liveState.baselineVersion || (json.data.meta && json.data.meta.dataVersion) || '')).trim();
      const localBaseVer = String((prevBaseline && prevBaseline.meta && prevBaseline.meta.dataVersion) || '').trim();
      const nowIso = new Date().toISOString();

      if (!prevBaseline || (remoteBaseVer && remoteBaseVer !== localBaseVer)) {
        await applyRemoteBaseline_(json.data, prevBaseline, nowIso);
      }

      const snapshot = liveState.state || { local_overrides: [], runtime_state: [] };
      await TripIdbStore.replaceSharedState(snapshot);

      saveLiveSyncMeta({
        revision: liveState.revision,
        baselineVersion: remoteBaseVer,
        publishedByDeviceId: liveState.publishedByDeviceId || '',
        publishedByName: liveState.publishedByName || '',
        publishedAt: liveState.publishedAt || '',
        hasUnpublished: false
      });

      return {
        ok: true,
        message: `已拉取「${liveState.publishedByName || '主控端'}」發布的 v${liveState.revision} 進度`,
        liveState: liveState
      };
    } finally {
      releaseSyncLock();
    }
  }

  /**
   * 發布本機共享進度快照至 GAS（push_live_state）。
   * 支援延遲自動發布（isAuto: true）與手動發布（isAuto: false），
   * 遇 HOST_MISMATCH 時可透過 onHostMismatch 詢問是否帶 allowHostTakeover: true 重送。
   * @param {Object} opts
   * @return {Promise<Object>}
   */
  async function pushLiveState(opts) {
    const cfg = opts || {};
    const isAuto = Boolean(cfg.isAuto);
    const allowTakeover = cfg.allowHostTakeover === true;
    const timeoutMs = cfg.timeoutMs || 20000;

    if (!isAuto) {
      clearAutoPublishTimer();
    }

    const endpointUrl = String(cfg.endpointUrl || '').trim();
    const publishToken = String(cfg.publishToken || '').trim();
    const deviceId = String(cfg.deviceId || '').trim();
    const deviceName = String(cfg.deviceName || '').trim();

    if (!endpointUrl) {
      return { ok: false, error: 'CONFIG_MISSING', message: '尚未設定 GAS Web App 網址' };
    }
    if (!publishToken) {
      return { ok: false, error: 'TOKEN_MISSING', message: '尚未設定 PUBLISH_TOKEN，無法發布進度' };
    }
    if (!deviceId || !deviceName) {
      return { ok: false, error: 'DEVICE_MISSING', message: '請先填寫主控裝置名稱' };
    }

    const lockTarget = isAuto ? LOCK_STATES.AUTO_PUBLISH : LOCK_STATES.MANUAL_PUBLISH;
    if (!acquireSyncLock(lockTarget)) {
      return { ok: false, error: 'SYNC_BUSY', message: '目前有同步作業正在進行，請稍後再試' };
    }

    try {
      const [baseline, overrides, runtimeItems] = await Promise.all([
        TripIdbStore.getBaseline(),
        TripIdbStore.getAllOverrides(),
        TripIdbStore.getAllRuntimeItems()
      ]);

      const localMeta = getLiveSyncMeta();
      const baselineVersion = String((baseline && baseline.meta && baseline.meta.dataVersion) || '').trim();

      const bodyObj = {
        action: 'push_live_state',
        publishToken: publishToken,
        deviceId: deviceId,
        deviceName: deviceName,
        expectedRevision: localMeta.revision,
        baselineVersion: baselineVersion,
        allowHostTakeover: allowTakeover,
        state: {
          local_overrides: Array.isArray(overrides) ? overrides : [],
          runtime_state: Array.isArray(runtimeItems) ? runtimeItems : []
        }
      };

      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let rawText = '';

      try {
        const resp = await fetch(endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(bodyObj),
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
        rawText = await resp.text();
      } catch (err) {
        const isAbort = err && err.name === 'AbortError';
        return {
          ok: false,
          silentAutoError: isAuto,
          error: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
          message: isAbort
            ? '發布逾時，變更已保留在待發布狀態'
            : '目前離線或無法連線，變更已保留在待發布狀態'
        };
      } finally {
        if (timer) clearTimeout(timer);
      }

      let json;
      try {
        json = JSON.parse(rawText);
      } catch (e) {
        return {
          ok: false,
          silentAutoError: isAuto,
          error: 'BAD_JSON',
          message: '雲端回應非合法 JSON，變更已保留在待發布狀態'
        };
      }

      if (!json || json.ok !== true) {
        const errCode = (json && json.error) ? json.error : 'PUBLISH_REJECTED';

        if (errCode === 'HOST_MISMATCH' && typeof cfg.onHostMismatch === 'function') {
          releaseSyncLock();
          const decision = await cfg.onHostMismatch({
            serverRevision: json.serverRevision,
            publishedByDeviceId: json.publishedByDeviceId || '',
            publishedByName: json.publishedByName || '其他裝置',
            publishedAt: json.publishedAt || '',
            currentDeviceId: deviceId,
            currentDeviceName: deviceName
          });

          if (decision === 'takeover') {
            return await pushLiveState(Object.assign({}, cfg, {
              isAuto: false,
              allowHostTakeover: true
            }));
          }

          return {
            ok: false,
            error: 'HOST_MISMATCH_CANCELLED',
            switchToFamily: decision === 'switch_family',
            message: '已取消發布，未變更雲端主控權'
          };
        }

        const isTransient = (errCode === 'SERVER_BUSY' || errCode === 'INTERNAL_ERROR');
        return {
          ok: false,
          silentAutoError: isAuto && isTransient,
          error: errCode,
          serverRevision: json && json.serverRevision,
          publishedByName: json && json.publishedByName,
          message: (json && json.message) ? json.message : '發布未成功，請稍後再試'
        };
      }

      saveLiveSyncMeta({
        revision: json.revision,
        baselineVersion: json.baselineVersion || baselineVersion,
        publishedByDeviceId: json.publishedByDeviceId || deviceId,
        publishedByName: json.publishedByName || deviceName,
        publishedAt: json.publishedAt || '',
        hasUnpublished: false
      });

      return {
        ok: true,
        revision: json.revision,
        publishedByName: json.publishedByName || deviceName,
        publishedAt: json.publishedAt || '',
        message: `已發布共享進度 v${json.revision}（主控：${json.publishedByName || deviceName}）`
      };
    } finally {
      releaseSyncLock();
    }
  }

  /**
   * 合併單筆行程活動：baseline 底稿 + local_overrides 欄位覆寫（本機修改優先）。
   * @param {Object} baseItem
   * @param {Object|null|undefined} overrideRecord
   * @return {Object}
   */
  function mergeActivityWithOverride(baseItem, overrideRecord) {
    const merged = Object.assign({}, baseItem);
    if (overrideRecord && overrideRecord.fields && typeof overrideRecord.fields === 'object') {
      Object.keys(overrideRecord.fields).forEach((field) => {
        if (overrideRecord.fields[field] !== undefined) {
          merged[field] = overrideRecord.fields[field];
        }
      });
      merged._hasOverrides = Object.keys(overrideRecord.fields).length > 0;
      merged._overriddenFields = Object.keys(overrideRecord.fields);
    } else {
      merged._hasOverrides = false;
      merged._overriddenFields = [];
    }
    return merged;
  }

  return {
    LOCK_STATES,
    AUTO_PUBLISH_DELAY_MS,
    getLockState,
    clearAutoPublishTimer,
    getLiveSyncMeta,
    saveLiveSyncMeta,
    notifyLocalChange,
    scheduleAutoPublish,
    buildSyncUrl,
    validateRemoteData,
    syncFromCloud,
    pullLiveState,
    pushLiveState,
    mergeActivityWithOverride
  };
})();
if (typeof TripSyncService !== 'undefined') window.TripSyncService = TripSyncService;
