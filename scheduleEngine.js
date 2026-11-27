/**
 * ============================================================================
 * 檔案名稱：scheduleEngine.js
 * 整體程式說明：
 *   PWA 現場執行與時間計算引擎（輕量化動態組裝版）
 *   依賴：TripIdbStore（idbStore.js）、TripSyncService（syncService.js）
 *
 *   核心調整重點：
 *   1. 四層起算優先級：當日臨時調整 (start:<tripDate>) > 站點固定 start_time > 設定頁預設值 > 保底 07:30。
 *   2. skipped 站點處理：不進入時間推算迴圈、不推進後續時間游標，有效尾站依最後一張非 skipped 站點判定。
 *   3. done 站點處理：標記完成時透過 extraMeta 記錄 completedAt（ISO 時間字串）。
 *   4. 固定時間（fixed）與等待/逾時：提早抵達 arrive_by 站點時計算 waitMin 並於預約時間起算停留；超過截止則標記 isLate。
 *   5. 輕量交通時間還原：插入站點並微調前一站 travel_min 時記錄參考快照，移除時僅在安全條件成立下還原。
 *   6. 複製加點捷徑：支援複製同日或跨天站點作為當日插入站點（extra:<tripDate>），錨定於指定站點之後。
 * ============================================================================
 */

const TripScheduleEngine = (() => {
  const DEFAULT_START_TIME = '07:30';
  const PREF_DEFAULT_START_KEY = 'trip_pwa_default_start_time';

  function timeToMinutes(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function minutesToTime(mins) {
    if (typeof mins !== 'number' || !isFinite(mins)) return '';
    const wrapped = ((Math.floor(mins) % 1440) + 1440) % 1440;
    const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const mm = String(wrapped % 60).padStart(2, '0');
    return hh + ':' + mm;
  }

  function isNextDayMinutes(mins) {
    return typeof mins === 'number' && isFinite(mins) && mins >= 1440;
  }

  function nonNegInt(val, fallback) {
    if (typeof val === 'number' && isFinite(val) && val >= 0) return Math.floor(val);
    if (typeof val === 'string' && /^(0|[1-9]\d*)$/.test(val.trim())) return parseInt(val.trim(), 10);
    return fallback;
  }

  /**
   * 讀取設定檔中的「預設每日出發時間」，若無或格式不符則回傳保底值 '07:30'。
   * @return {string} HH:MM
   */
  function getConfiguredDefaultStartTime() {
    if (typeof localStorage !== 'undefined') {
      const saved = String(localStorage.getItem(PREF_DEFAULT_START_KEY) || '').trim();
      if (timeToMinutes(saved) !== null) {
        return saved;
      }
    }
    return DEFAULT_START_TIME;
  }

  /**
   * 讀取特定日期的臨時調整出發時間（存於 runtime_state 的 start:<tripDate>）。
   * @param {string} tripDate
   * @return {Promise<string>} HH:MM 或空字串
   */
  async function getDayStartTimeOverride(tripDate) {
    if (!tripDate) return '';
    const rec = await TripIdbStore.getRuntimeItem('start:' + String(tripDate).trim());
    if (rec && typeof rec.start_time === 'string' && timeToMinutes(rec.start_time) !== null) {
      return rec.start_time.trim();
    }
    return '';
  }

  /**
   * 設定或清除特定日期的臨時調整出發時間。
   * @param {string} tripDate
   * @param {string} hhmm 傳入空字串代表清除臨時調整，恢復預設起算
   * @return {Promise<Object>}
   */
  async function setDayStartTimeOverride(tripDate, hhmm) {
    if (!tripDate) throw new Error('缺少日期');
    const clean = String(hhmm || '').trim();
    if (clean !== '' && timeToMinutes(clean) === null) {
      throw new Error('時間格式無效，請使用 HH:MM（例如 08:30）');
    }
    await TripIdbStore.putRuntimeItem({
      key: 'start:' + String(tripDate).trim(),
      type: 'day_start_time',
      trip_date: String(tripDate).trim(),
      start_time: clean
    });
    return await buildDaySchedule(tripDate);
  }

  /**
   * 建構某一日的完整行程清單與推算時間
   * @param {string} tripDate YYYY-MM-DD
   * @param {{includeStoppedRemaining?: boolean}} opts
   */
  async function buildDaySchedule(tripDate, opts) {
    const includeStoppedRemaining = Boolean(opts && opts.includeStoppedRemaining);
    const baseline = await TripIdbStore.getBaseline();
    const defaultStartTime = getConfiguredDefaultStartTime();

    if (!baseline || !Array.isArray(baseline.itinerary)) {
      return {
        hasBaseline: false,
        tripDate: tripDate,
        weatherMode: 'sun',
        isStopped: false,
        dayStartOverride: '',
        effectiveStartTime: defaultStartTime,
        items: [],
        visibleItems: [],
        stats: { total: 0, done: 0, skipped: 0, pending: 0, lateCount: 0 }
      };
    }

    const [overridesList, runtimeItems, insertedList, isStopped, dayStartOverride] = await Promise.all([
      TripIdbStore.getAllOverrides(),
      TripIdbStore.getAllRuntimeItems(),
      TripIdbStore.getInsertedSpots(tripDate),
      TripIdbStore.getDayStopped(tripDate),
      getDayStartTimeOverride(tripDate)
    ]);

    const overrideMap = new Map();
    overridesList.forEach((ov) => {
      if (ov && ov.activity_id) overrideMap.set(String(ov.activity_id), ov);
    });

    const statusMap = new Map();
    const completedAtMap = new Map();
    runtimeItems.forEach((rt) => {
      if (rt && rt.type === 'activity_status' && rt.activity_id) {
        const idStr = String(rt.activity_id);
        statusMap.set(idStr, rt.status || 'pending');
        if (rt.completedAt) completedAtMap.set(idStr, rt.completedAt);
      }
    });

    const weatherMode = await TripIdbStore.getDayWeather(tripDate, 'sun');

    // 1. 篩出當日底稿活動並合併本機覆寫與執行狀態
    const dayRaw = baseline.itinerary
      .filter((item) => String(item.trip_date || '').trim() === String(tripDate).trim())
      .map((item, idx) => {
        const actId = String(item.activity_id);
        const merged = TripSyncService.mergeActivityWithOverride(item, overrideMap.get(actId));
        const status = statusMap.get(actId) || 'pending';
        return Object.assign({}, merged, {
          _origIndex: idx,
          _sourceType: 'baseline',
          status: status,
          completedAt: completedAtMap.get(actId) || '',
          sort_order: nonNegInt(merged.sort_order, (idx + 1) * 10),
          dwell_min: nonNegInt(merged.dwell_min, 0),
          travel_min: nonNegInt(merged.travel_min, 0),
          buffer_min: nonNegInt(merged.buffer_min, 0)
        });
      });

    // 2. 晴雨槽位篩選
    const lockedSlotIds = new Set();
    dayRaw.forEach((act) => {
      if (act.slot_id && (act.status === 'done' || act.status === 'skipped')) {
        lockedSlotIds.add(String(act.slot_id));
      }
    });

    const filteredMain = dayRaw.filter((act) => {
      const slotId = String(act.slot_id || '');
      if (slotId && lockedSlotIds.has(slotId)) {
        return act.status === 'done' || act.status === 'skipped';
      }
      const wm = act.weather_mode || 'all';
      return wm === 'all' || wm === weatherMode;
    });

    // 3. 依 sort_order 排序
    filteredMain.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a._origIndex - b._origIndex;
    });

    // 4. 插入本機新增／複製之站點（依 after_activity_id 錨點；若錨點不存在或被移除則就近補位/接尾）
    const mainIdSet = new Set(filteredMain.map((a) => String(a.activity_id)));
    const topInsertions = [];
    const afterMap = new Map();
    const orphanInsertions = [];

    (insertedList || []).forEach((ins, idx) => {
      const anchor = ins.after_activity_id || 'TOP';
      const insActId = String(ins.insert_id || ins.pocket_id || ('EXTRA-' + idx));
      const insStatus = statusMap.get(insActId) || ins.status || 'pending';
      const spotObj = {
        activity_id: insActId,
        pocket_id: ins.pocket_id || '',
        copied_from_id: ins.copied_from_id || '',
        copied_from_date: ins.copied_from_date || '',
        slot_id: '',
        trip_date: tripDate,
        day_label: filteredMain[0] ? filteredMain[0].day_label : '',
        weather_mode: 'all',
        time_type: 'flexible',
        start_time: '',
        deadline_time: '',
        deadline_type: '',
        dwell_min: nonNegInt(ins.dwell_min, nonNegInt(ins.default_dwell_min, 30)),
        travel_min: nonNegInt(ins.travel_min, nonNegInt(ins.default_travel_min, 15)),
        buffer_min: nonNegInt(ins.buffer_min, 0),
        transport_mode: ins.transport_mode || ins.default_transport_mode || '',
        area: ins.area || '',
        title_zh: ins.title_zh || '',
        title_jp: ins.title_jp || '',
        address_jp: ins.address_jp || '',
        coords: ins.coords || '',
        note: ins.note || '',
        status: insStatus,
        completedAt: completedAtMap.get(insActId) || '',
        _sourceType: 'inserted',
        _afterActivityId: anchor,
        _anchorMissing: false,
        _hasOverrides: false,
        _overriddenFields: []
      };

      if (anchor === 'TOP') {
        topInsertions.push(spotObj);
      } else if (mainIdSet.has(String(anchor))) {
        if (!afterMap.has(String(anchor))) afterMap.set(String(anchor), []);
        afterMap.get(String(anchor)).push(spotObj);
      } else {
        spotObj._anchorMissing = true;
        orphanInsertions.push(spotObj);
      }
    });

    const combined = [];
    topInsertions.forEach((s) => combined.push(s));
    filteredMain.forEach((act) => {
      combined.push(act);
      const followers = afterMap.get(String(act.activity_id));
      if (followers && followers.length > 0) {
        followers.forEach((s) => combined.push(s));
      }
    });
    orphanInsertions.forEach((s) => combined.push(s));

    // 找出最後一張「非 skipped 且非收工隱藏」的有效站點索引，作為真正的 isLastOfDay 依據
    let lastActiveIdx = -1;
    for (let i = combined.length - 1; i >= 0; i--) {
      const it = combined[i];
      const hiddenByStop = Boolean(isStopped && it.status === 'pending');
      if (it.status !== 'skipped' && !hiddenByStop) {
        lastActiveIdx = i;
        break;
      }
    }

    // 5. 時間推算（skipped 不進推算且不推進游標；支援四層起算時間與 fixed 等待/逾時檢查）
    let cursorMin = null;
    let effectiveStartTime = dayStartOverride || defaultStartTime;
    let lateCount = 0;
    let doneCount = 0;
    let skippedCount = 0;
    let pendingCount = 0;

    const scheduled = combined.map((item, idx) => {
      const hiddenByStop = Boolean(isStopped && item.status === 'pending');

      if (item.status === 'done') doneCount++;
      else if (item.status === 'skipped') skippedCount++;
      else pendingCount++;

      // skipped 或已收工隱藏之站點：不參與時間推算、不推進時間游標
      if (item.status === 'skipped' || hiddenByStop) {
        return Object.assign({}, item, {
          index: idx,
          isLastOfDay: false,
          estArrive: '',
          estArriveNextDay: false,
          estDepart: '',
          estDepartNextDay: false,
          nextArrive: '',
          nextArriveNextDay: false,
          effectiveTravelMin: 0,
          effectiveBufferMin: 0,
          waitMin: 0,
          isLate: false,
          lateReason: '',
          hiddenByStop: hiddenByStop
        });
      }

      const isLastOfDay = idx === lastActiveIdx;
      const itemStartMin = timeToMinutes(item.start_time);
      const dayOverrideMin = timeToMinutes(dayStartOverride);
      const configDefaultMin = timeToMinutes(defaultStartTime);

      let arriveMin;
      let waitMin = 0;

      if (cursorMin === null) {
        // 第一張有效站點四層起算優先級：
        // 1. 當日臨時調整 (dayStartOverride)
        // 2. 該站固定/指定 start_time
        // 3. 設定頁預設每日出發時間 (defaultStartTime)
        // 4. 保底 07:30 (7 * 60 + 30)
        if (dayOverrideMin !== null) {
          arriveMin = dayOverrideMin;
        } else if (itemStartMin !== null) {
          arriveMin = itemStartMin;
        } else if (configDefaultMin !== null) {
          arriveMin = configDefaultMin;
        } else {
          arriveMin = 7 * 60 + 30;
        }
        effectiveStartTime = minutesToTime(arriveMin);
      } else {
        arriveMin = cursorMin;
        // 若中間站點有明確指定 start_time 且早到，計算等待分鐘數並於該時間起算停留
        if (itemStartMin !== null && arriveMin < itemStartMin) {
          waitMin = itemStartMin - arriveMin;
        }
      }

      // 若為 fixed 且 arrive_by 提早抵達，記錄等待分鐘數（保持原抵達與截止語意不篡改）
      if (item.time_type === 'fixed' && item.deadline_time && item.deadline_type === 'arrive_by') {
        const dlMin = timeToMinutes(item.deadline_time);
        if (dlMin !== null && arriveMin < dlMin && waitMin === 0) {
          waitMin = dlMin - arriveMin;
        }
      }

      const serviceStartMin = arriveMin + waitMin;
      const departMin = serviceStartMin + item.dwell_min;
      let isLate = false;
      let lateReason = '';

      if (item.time_type === 'fixed' && item.deadline_time) {
        const dlMin = timeToMinutes(item.deadline_time);
        if (dlMin !== null) {
          if (item.deadline_type === 'arrive_by' && arriveMin > dlMin) {
            isLate = true;
            lateReason = '預計抵達 ' + minutesToTime(arriveMin) + ' 已超過固定抵達截止 ' + item.deadline_time;
          } else if (item.deadline_type === 'depart_by' && departMin > dlMin) {
            isLate = true;
            lateReason = '預計離開 ' + minutesToTime(departMin) + ' 已超過固定出發截止 ' + item.deadline_time;
          }
        }
      }

      if (isLate) lateCount++;

      const effectiveTravelMin = isLastOfDay ? 0 : item.travel_min;
      const effectiveBufferMin = isLastOfDay ? 0 : item.buffer_min;
      const nextArriveMin = isLastOfDay ? null : (departMin + effectiveTravelMin + effectiveBufferMin);

      if (!isLastOfDay) {
        cursorMin = nextArriveMin;
      }

      return Object.assign({}, item, {
        index: idx,
        isLastOfDay: isLastOfDay,
        estArrive: minutesToTime(arriveMin),
        estArriveNextDay: isNextDayMinutes(arriveMin),
        estDepart: minutesToTime(departMin),
        estDepartNextDay: isNextDayMinutes(departMin),
        nextArrive: nextArriveMin !== null ? minutesToTime(nextArriveMin) : '',
        nextArriveNextDay: nextArriveMin !== null ? isNextDayMinutes(nextArriveMin) : false,
        effectiveTravelMin: effectiveTravelMin,
        effectiveBufferMin: effectiveBufferMin,
        waitMin: waitMin,
        isLate: isLate,
        lateReason: lateReason,
        hiddenByStop: hiddenByStop
      });
    });

    const visibleItems = includeStoppedRemaining
      ? scheduled
      : scheduled.filter((it) => !it.hiddenByStop);

    return {
      hasBaseline: true,
      tripDate: tripDate,
      weatherMode: weatherMode,
      isStopped: isStopped,
      dayStartOverride: dayStartOverride,
      effectiveStartTime: effectiveStartTime,
      items: scheduled,
      visibleItems: visibleItems,
      stats: {
        total: scheduled.length,
        done: doneCount,
        skipped: skippedCount,
        pending: pendingCount,
        lateCount: lateCount
      }
    };
  }

  async function toggleWeather(tripDate) {
    const current = await TripIdbStore.getDayWeather(tripDate, 'sun');
    const next = current === 'sun' ? 'rain' : 'sun';
    await TripIdbStore.setDayWeather(tripDate, next);
    return await buildDaySchedule(tripDate);
  }

  async function setActivityStatus(activityId, status, tripDate) {
    const extraMeta = {};
    if (tripDate) extraMeta.trip_date = tripDate;
    if (status === 'done') {
      extraMeta.completedAt = new Date().toISOString();
    } else {
      extraMeta.completedAt = '';
    }
    await TripIdbStore.setActivityStatus(activityId, status, extraMeta);
    return tripDate ? await buildDaySchedule(tripDate) : null;
  }

  async function toggleDayStop(tripDate) {
    const stopped = await TripIdbStore.getDayStopped(tripDate);
    await TripIdbStore.setDayStopped(tripDate, !stopped);
    return await buildDaySchedule(tripDate);
  }

  /**
   * 插入備選景點或複製站點至指定日期與錨點後方。
   * 若提供 customOpts.anchorNewTravelMin，會同步調整錨點站點之 travel_min 並記錄輕量還原快照。
   */
  async function insertPocketSpot(tripDate, pocketSpot, afterActivityId, customOpts) {
    if (!tripDate || !pocketSpot) throw new Error('缺少日期或景點資料');
    const currentList = await TripIdbStore.getInsertedSpots(tripDate);
    const opts = customOpts || {};
    const anchorId = afterActivityId || 'TOP';

    let anchorPrevTravelMin = null;
    let appliedTravelMin = null;

    if (anchorId !== 'TOP' && opts.anchorNewTravelMin !== undefined && opts.anchorNewTravelMin !== null) {
      const nextTravel = nonNegInt(opts.anchorNewTravelMin, null);
      if (nextTravel !== null) {
        const baseline = await TripIdbStore.getBaseline();
        const baseItem = (baseline && Array.isArray(baseline.itinerary))
          ? baseline.itinerary.find((x) => String(x.activity_id) === String(anchorId))
          : null;
        if (baseItem) {
          const ov = await TripIdbStore.getOverride(anchorId);
          const prevVal = (ov && ov.fields && ov.fields.travel_min !== undefined)
            ? nonNegInt(ov.fields.travel_min, nonNegInt(baseItem.travel_min, 0))
            : nonNegInt(baseItem.travel_min, 0);
          anchorPrevTravelMin = prevVal;
          appliedTravelMin = nextTravel;
          await TripIdbStore.setFieldOverrides(anchorId, tripDate, { travel_min: nextTravel });
        }
      }
    }

    const prefix = pocketSpot.pocket_id ? String(pocketSpot.pocket_id) : 'COPY';
    const entry = {
      insert_id: 'INS-' + prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
      pocket_id: pocketSpot.pocket_id || '',
      copied_from_id: pocketSpot.copied_from_id || '',
      copied_from_date: pocketSpot.copied_from_date || '',
      after_activity_id: anchorId,
      insertedAt: new Date().toISOString(),
      dwell_min: opts.dwell_min !== undefined ? nonNegInt(opts.dwell_min, 30) : nonNegInt(pocketSpot.dwell_min !== undefined ? pocketSpot.dwell_min : pocketSpot.default_dwell_min, 30),
      travel_min: opts.travel_min !== undefined ? nonNegInt(opts.travel_min, 15) : nonNegInt(pocketSpot.travel_min !== undefined ? pocketSpot.travel_min : pocketSpot.default_travel_min, 15),
      buffer_min: opts.buffer_min !== undefined ? nonNegInt(opts.buffer_min, 0) : nonNegInt(pocketSpot.buffer_min, 0),
      transport_mode: opts.transport_mode !== undefined ? opts.transport_mode : (pocketSpot.transport_mode || ''),
      area: pocketSpot.area || '',
      title_zh: pocketSpot.title_zh || '',
      title_jp: pocketSpot.title_jp || '',
      address_jp: pocketSpot.address_jp || '',
      coords: pocketSpot.coords || '',
      note: opts.note !== undefined ? opts.note : (pocketSpot.note || ''),
      _anchorPrevTravelMin: anchorPrevTravelMin,
      _appliedTravelMin: appliedTravelMin
    };
    currentList.push(entry);
    await TripIdbStore.saveInsertedSpots(tripDate, currentList);
    return await buildDaySchedule(tripDate);
  }

  /**
   * 複製既有行程站點（可同日或跨天）加入指定日期與錨點後方。
   * @param {string} targetTripDate 目標加入日期（如當日）
   * @param {Object} sourceActivity 來源站點物件
   * @param {string} afterActivityId 插入在哪一站後面（'TOP' 或 activity_id）
   * @param {Object=} customOpts
   */
  async function copyActivityAfter(targetTripDate, sourceActivity, afterActivityId, customOpts) {
    if (!targetTripDate || !sourceActivity) throw new Error('缺少目標日期或來源站點');
    const template = {
      pocket_id: '',
      copied_from_id: String(sourceActivity.activity_id || ''),
      copied_from_date: String(sourceActivity.trip_date || ''),
      dwell_min: nonNegInt(sourceActivity.dwell_min, 30),
      travel_min: nonNegInt(sourceActivity.travel_min, 15),
      buffer_min: nonNegInt(sourceActivity.buffer_min, 0),
      transport_mode: sourceActivity.transport_mode || '',
      area: sourceActivity.area || '',
      title_zh: sourceActivity.title_zh || '',
      title_jp: sourceActivity.title_jp || '',
      address_jp: sourceActivity.address_jp || '',
      coords: sourceActivity.coords || '',
      note: sourceActivity.note || ''
    };
    return await insertPocketSpot(targetTripDate, template, afterActivityId, customOpts);
  }

  /**
   * 移除本機插入之站點；若當時有記錄前一站交通時間快照且安全條件成立，執行輕量還原。
   */
  async function removeInsertedSpot(tripDate, insertId) {
    const currentList = await TripIdbStore.getInsertedSpots(tripDate);
    const target = currentList.find((it) => it.insert_id === insertId);
    const nextList = currentList.filter((it) => it.insert_id !== insertId);
    await TripIdbStore.saveInsertedSpots(tripDate, nextList);

    // 輕量交通時間還原：僅當錨點仍在、未手動覆寫改過其他值、且同錨點無後續插入站點佔用時還原
    if (target &&
        target.after_activity_id &&
        target.after_activity_id !== 'TOP' &&
        target._anchorPrevTravelMin !== null &&
        target._anchorPrevTravelMin !== undefined &&
        target._appliedTravelMin !== null &&
        target._appliedTravelMin !== undefined) {
      const anchorId = String(target.after_activity_id);
      const stillHasOtherFollower = nextList.some((it) => String(it.after_activity_id) === anchorId);
      if (!stillHasOtherFollower) {
        const baseline = await TripIdbStore.getBaseline();
        const baseItem = (baseline && Array.isArray(baseline.itinerary))
          ? baseline.itinerary.find((x) => String(x.activity_id) === anchorId)
          : null;
        const ov = await TripIdbStore.getOverride(anchorId);
        if (baseItem && ov && ov.fields && ov.fields.travel_min !== undefined) {
          const currentTravel = nonNegInt(ov.fields.travel_min, -1);
          if (currentTravel === nonNegInt(target._appliedTravelMin, -2)) {
            const baseTravel = nonNegInt(baseItem.travel_min, 0);
            if (nonNegInt(target._anchorPrevTravelMin, 0) === baseTravel) {
              await TripIdbStore.clearFieldOverride(anchorId, 'travel_min');
            } else {
              await TripIdbStore.setFieldOverrides(anchorId, tripDate, {
                travel_min: nonNegInt(target._anchorPrevTravelMin, 0)
              });
            }
          }
        }
      }
    }

    return await buildDaySchedule(tripDate);
  }

  async function updateActivityOverride(activityId, tripDate, partialFields) {
    await TripIdbStore.setFieldOverrides(activityId, tripDate, partialFields);
    return tripDate ? await buildDaySchedule(tripDate) : null;
  }

  async function resetActivityField(activityId, fieldName, tripDate) {
    await TripIdbStore.clearFieldOverride(activityId, fieldName);
    return tripDate ? await buildDaySchedule(tripDate) : null;
  }

  async function restoreAllToBaseline() {
    await TripIdbStore.restoreAllToBaseline();
  }

  return {
    DEFAULT_START_TIME,
    PREF_DEFAULT_START_KEY,
    timeToMinutes,
    minutesToTime,
    isNextDayMinutes,
    getConfiguredDefaultStartTime,
    getDayStartTimeOverride,
    setDayStartTimeOverride,
    buildDaySchedule,
    toggleWeather,
    setActivityStatus,
    toggleDayStop,
    insertPocketSpot,
    copyActivityAfter,
    removeInsertedSpot,
    updateActivityOverride,
    resetActivityField,
    restoreAllToBaseline
  };
})();
if (typeof TripScheduleEngine !== 'undefined') window.TripScheduleEngine = TripScheduleEngine;
