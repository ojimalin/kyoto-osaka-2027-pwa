/**
 * scheduleEngine.js
 * PWA 現場執行與時間計算引擎
 * 依賴：TripIdbStore（idbStore.js）、TripSyncService（syncService.js）
 */

const TripScheduleEngine = (() => {
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
   * 建構某一日的完整行程清單與推算時間
   * @param {string} tripDate YYYY-MM-DD
   * @param {{includeStoppedRemaining?: boolean}} opts 若為 true，收工的剩餘 pending 也會回傳但標記 hiddenByStop: true
   */
  async function buildDaySchedule(tripDate, opts) {
    const includeStoppedRemaining = Boolean(opts && opts.includeStoppedRemaining);
    const baseline = await TripIdbStore.getBaseline();

    if (!baseline || !Array.isArray(baseline.itinerary)) {
      return {
        hasBaseline: false,
        tripDate: tripDate,
        weatherMode: 'sun',
        isStopped: false,
        items: [],
        visibleItems: [],
        stats: { total: 0, done: 0, skipped: 0, pending: 0, lateCount: 0 }
      };
    }

    const [overridesList, runtimeItems, insertedList, isStopped] = await Promise.all([
      TripIdbStore.getAllOverrides(),
      TripIdbStore.getAllRuntimeItems(),
      TripIdbStore.getInsertedSpots(tripDate),
      TripIdbStore.getDayStopped(tripDate)
    ]);

    const overrideMap = new Map();
    overridesList.forEach((ov) => {
      if (ov && ov.activity_id) overrideMap.set(String(ov.activity_id), ov);
    });

    const statusMap = new Map();
    runtimeItems.forEach((rt) => {
      if (rt && rt.type === 'activity_status' && rt.activity_id) {
        statusMap.set(String(rt.activity_id), rt.status || 'pending');
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
          sort_order: nonNegInt(merged.sort_order, (idx + 1) * 10),
          dwell_min: nonNegInt(merged.dwell_min, 0),
          travel_min: nonNegInt(merged.travel_min, 0),
          buffer_min: nonNegInt(merged.buffer_min, 0)
        });
      });

    // 2. 晴雨槽位篩選：
    //    同 slot_id 若已有 done 或 skipped 的活動，保留該原活動不替換；
    //    僅對 pending 槽位依當日 weatherMode（或 'all'）篩選。
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

    // 3. 依 sort_order 排序（同分保留原順序）
    filteredMain.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a._origIndex - b._origIndex;
    });

    // 4. 將本機插入之備選景點依 after_activity_id 錨點插入（同錨點依插入先後；錨點不存在則接在當日末端）
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

    // 5. 時間推算（分鐘制 -> HH:MM，處理 fixed 截止時間逾時警示與當日末站不計下段移動/緩衝）
    let cursorMin = null;
    let lateCount = 0;
    let doneCount = 0;
    let skippedCount = 0;
    let pendingCount = 0;

    const scheduled = combined.map((item, idx) => {
      const isLastOfDay = idx === combined.length - 1;

      if (item.status === 'done') doneCount++;
      else if (item.status === 'skipped') skippedCount++;
      else pendingCount++;

      const startMin = timeToMinutes(item.start_time);
      let arriveMin;
      if (cursorMin === null) {
        arriveMin = startMin !== null ? startMin : 9 * 60;
      } else {
        arriveMin = cursorMin;
        if (item.time_type === 'fixed' && item.deadline_type === 'arrive_by') {
          const dlMin = timeToMinutes(item.deadline_time);
          if (dlMin !== null && arriveMin < dlMin) {
            // 尚未到固定抵達時間，依截止時間或維持推算（此處保留推算並標記待到點）
          }
        }
      }

      let departMin = arriveMin + item.dwell_min;
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

      const hiddenByStop = Boolean(isStopped && item.status === 'pending');

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
    await TripIdbStore.setActivityStatus(activityId, status, tripDate ? { trip_date: tripDate } : null);
    return tripDate ? await buildDaySchedule(tripDate) : null;
  }

  async function toggleDayStop(tripDate) {
    const stopped = await TripIdbStore.getDayStopped(tripDate);
    await TripIdbStore.setDayStopped(tripDate, !stopped);
    return await buildDaySchedule(tripDate);
  }

  async function insertPocketSpot(tripDate, pocketSpot, afterActivityId, customOpts) {
    if (!tripDate || !pocketSpot) throw new Error('缺少日期或備選景點資料');
    const currentList = await TripIdbStore.getInsertedSpots(tripDate);
    const opts = customOpts || {};
    const entry = {
      insert_id: 'INS-' + String(pocketSpot.pocket_id || 'PK') + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5),
      pocket_id: pocketSpot.pocket_id || '',
      after_activity_id: afterActivityId || 'TOP',
      insertedAt: new Date().toISOString(),
      dwell_min: opts.dwell_min !== undefined ? nonNegInt(opts.dwell_min, 30) : nonNegInt(pocketSpot.default_dwell_min, 30),
      travel_min: opts.travel_min !== undefined ? nonNegInt(opts.travel_min, 15) : nonNegInt(pocketSpot.default_travel_min, 15),
      buffer_min: opts.buffer_min !== undefined ? nonNegInt(opts.buffer_min, 0) : 0,
      transport_mode: opts.transport_mode !== undefined ? opts.transport_mode : (pocketSpot.transport_mode || ''),
      area: pocketSpot.area || '',
      title_zh: pocketSpot.title_zh || '',
      title_jp: pocketSpot.title_jp || '',
      address_jp: pocketSpot.address_jp || '',
      coords: pocketSpot.coords || '',
      note: opts.note !== undefined ? opts.note : (pocketSpot.note || '')
    };
    currentList.push(entry);
    await TripIdbStore.saveInsertedSpots(tripDate, currentList);
    return await buildDaySchedule(tripDate);
  }

  async function removeInsertedSpot(tripDate, insertId) {
    const currentList = await TripIdbStore.getInsertedSpots(tripDate);
    const nextList = currentList.filter((it) => it.insert_id !== insertId);
    await TripIdbStore.saveInsertedSpots(tripDate, nextList);
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
    timeToMinutes,
    minutesToTime,
    isNextDayMinutes,
    buildDaySchedule,
    toggleWeather,
    setActivityStatus,
    toggleDayStop,
    insertPocketSpot,
    removeInsertedSpot,
    updateActivityOverride,
    resetActivityField,
    restoreAllToBaseline
  };
})();
if (typeof TripScheduleEngine !== 'undefined') window.TripScheduleEngine = TripScheduleEngine;
