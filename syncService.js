/**
 * syncService.js
 * 手動同步雲端底稿服務（單向：雲端 -> 手機 baseline）
 * 職責：
 *   1. 呼叫 GAS Web App (06_Api.gs) 端點 ?token=... 取得 JSON 資料包。
 *   2. 驗證回應格式；若失敗（含離線/網路錯誤/UNAUTHORIZED/BUSY/DATA_INVALID）則保留既有 baseline 不動。
 *   3. 更新 baseline，並將「雲端已刪除但本機曾有欄位修改」的活動移入 removed_history（不自動刪除也不塞回主行程）。
 *   4. 保留現有 local_overrides（欄位層級覆寫優先於新 baseline）、runtime_state 與 inserted_spots。
 */

const TripSyncService = (() => {
  /**
   * 建構完整請求 URL（安全附加 token 查詢參數）。
   */
  function buildSyncUrl(endpointUrl, token) {
    const cleanUrl = String(endpointUrl || '').trim();
    const cleanToken = String(token || '').trim();
    if (!cleanUrl) {
      throw new Error('尚未設定 GAS Web App 網址');
    }
    if (!cleanToken) {
      throw new Error('尚未設定 API_TOKEN');
    }
    const sep = cleanUrl.indexOf('?') === -1 ? '?' : '&';
    return cleanUrl + sep + 'token=' + encodeURIComponent(cleanToken);
  }

  /**
   * 驗證 06_Api.gs 回傳的資料包結構是否完整。
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
   * 執行手動同步雲端底稿。
   * @param {{endpointUrl: string, token: string, timeoutMs?: number}} opts
   * @return {Promise<{ok: boolean, error?: string, message: string, movedToHistoryCount?: number, baseline?: Object}>}
   */
  async function syncFromCloud(opts) {
    const timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 20000;
    let url;
    try {
      url = buildSyncUrl(opts && opts.endpointUrl, opts && opts.token);
    } catch (e) {
      return { ok: false, error: 'CONFIG_MISSING', message: e.message };
    }

    const prevBaseline = await TripIdbStore.getBaseline();
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
      if (timer) clearTimeout(timer);
      const isAbort = err && err.name === 'AbortError';
      return {
        ok: false,
        error: isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: isAbort
          ? '同步逾時，已保留本機既有底稿不變'
          : '目前處於離線或無法連線至雲端，已保留本機既有底稿不變'
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
        message: '雲端回應非合法 JSON，已保留本機既有底稿不變'
      };
    }

    if (!json || json.ok !== true) {
      return {
        ok: false,
        error: (json && json.error) ? json.error : 'SYNC_REJECTED',
        message: (json && json.message) ? json.message : '雲端拒絕同步，已保留本機既有底稿不變'
      };
    }

    const schemaErr = validateRemoteData(json.data);
    if (schemaErr) {
      return {
        ok: false,
        error: 'SCHEMA_INVALID',
        message: schemaErr + '，已保留本機既有底稿不變'
      };
    }

    // 1. 比對雲端已移除的活動：若本機 local_overrides 有修改紀錄，移入 removed_history
    const newActIdSet = new Set(
      json.data.itinerary.map((item) => String(item.activity_id || '').trim()).filter(Boolean)
    );
    const prevActMap = new Map();
    if (prevBaseline && Array.isArray(prevBaseline.itinerary)) {
      prevBaseline.itinerary.forEach((item) => {
        if (item.activity_id) prevActMap.set(String(item.activity_id).trim(), item);
      });
    }

    const currentOverrides = await TripIdbStore.getAllOverrides();
    const nowIso = new Date().toISOString();
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

    // 2. 寫入最新 baseline（local_overrides 其餘保留、runtime_state 保留）
    const savedBaseline = await TripIdbStore.saveBaseline(json.data, nowIso);

    return {
      ok: true,
      message: '已同步最新雲端底稿' + (movedToHistoryCount > 0 ? `（${movedToHistoryCount} 筆雲端已移除且曾修改的活動已移至歷史紀錄）` : ''),
      movedToHistoryCount,
      baseline: savedBaseline
    };
  }

  /**
   * 合併單筆行程活動：baseline 底稿 + local_overrides 欄位覆寫（本機修改優先）。
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
    buildSyncUrl,
    validateRemoteData,
    syncFromCloud,
    mergeActivityWithOverride
  };
})();
