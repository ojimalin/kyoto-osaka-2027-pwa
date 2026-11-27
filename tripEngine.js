/**
 * 無資料測試用(已廢止) 
 * tripEngine.js — 資料正規化、晴雨路線、時間軸推算（純函式，不碰 DOM／儲存）
 * 規則：開始 = max(前站推算起點, start_time)；彈性站起點含緩衝、固定站不含；
 *       有效最後一站忽略交通／緩衝；跳過的站不影響後續；完成可帶實際結束時間。
 */
(function (global) {
  'use strict';
  const WEATHER = new Set(['sun', 'rain', 'all']);
  const IO = new Set(['indoor', 'outdoor', 'mixed']);
  const s = (v) => (v === null || v === undefined ? '' : String(v).trim());
  const pick = (o, a, b) => (o[a] !== undefined ? o[a] : o[b]);

  function nonNeg(v, def) {
    const d = def || 0;
    if (v === null || v === undefined || s(v) === '') return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : d;
  }

  /** 接受 HH:MM、H:MM、HH:MM:SS，回傳分鐘數或 null */
  function parseHHMM(v) {
    const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(s(v));
    if (!m || +m[1] > 23) return null;
    return +m[1] * 60 + +m[2];
  }

  function formatMinutes(t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return { text: '', minutes: null, isNextDay: false };
    const w = ((Math.trunc(t) % 1440) + 1440) % 1440;
    const p = (n) => String(n).padStart(2, '0');
    return { text: p(Math.floor(w / 60)) + ':' + p(w % 60), minutes: t, isNextDay: t >= 1440 };
  }

  function normalizeItem(r) {
    r = r || {};
    const w = s(pick(r, 'weather_mode', 'weatherMode')).toLowerCase();
    return {
      slotId: s(pick(r, 'slot_id', 'slotId')),
      tripDate: s(pick(r, 'trip_date', 'tripDate')),
      dayLabel: s(pick(r, 'day_label', 'dayLabel')),
      weatherMode: w,
      invalidWeather: !WEATHER.has(w),
      timeType: s(pick(r, 'time_type', 'timeType')) || 'flexible',
      startTime: s(pick(r, 'start_time', 'startTime')),
      deadlineTime: s(pick(r, 'deadline_time', 'deadlineTime')),
      deadlineType: s(pick(r, 'deadline_type', 'deadlineType')),
      dwellMin: nonNeg(pick(r, 'dwell_min', 'dwellMin')),
      travelMin: nonNeg(pick(r, 'travel_min', 'travelMin')),
      bufferMin: nonNeg(pick(r, 'buffer_min', 'bufferMin')),
      transportMode: s(pick(r, 'transport_mode', 'transportMode')),
      area: s(r.area),
      sortOrder: nonNeg(pick(r, 'sort_order', 'sortOrder')),
      activityId: s(pick(r, 'activity_id', 'activityId')),
      titleZh: s(pick(r, 'title_zh', 'titleZh')),
      titleJp: s(pick(r, 'title_jp', 'titleJp')),
      addressJp: s(pick(r, 'address_jp', 'addressJp')),
      coords: s(r.coords),
      note: s(r.note)
    };
  }

  function normalizePocket(r) {
    r = r || {};
    const io = s(pick(r, 'indoor_outdoor', 'indoorOutdoor')).toLowerCase();
    return {
      pocketId: s(pick(r, 'pocket_id', 'pocketId')),
      area: s(r.area),
      indoorOutdoor: IO.has(io) ? io : 'mixed',
      defaultDwellMin: nonNeg(pick(r, 'default_dwell_min', 'defaultDwellMin')),
      defaultTravelMin: nonNeg(pick(r, 'default_travel_min', 'defaultTravelMin')),
      transportMode: s(pick(r, 'transport_mode', 'transportMode')),
      titleZh: s(pick(r, 'title_zh', 'titleZh')),
      titleJp: s(pick(r, 'title_jp', 'titleJp')),
      addressJp: s(pick(r, 'address_jp', 'addressJp')),
      note: s(r.note)
    };
  }

  function normalizeMeta(r) {
    r = r || {};
    return {
      metaId: s(pick(r, 'meta_id', 'metaId')),
      tripDate: s(pick(r, 'trip_date', 'tripDate')),
      category: s(r.category),
      titleZh: s(pick(r, 'title_zh', 'titleZh')),
      titleJp: s(pick(r, 'title_jp', 'titleJp')),
      addressJp: s(pick(r, 'address_jp', 'addressJp')),
      infoText: s(pick(r, 'info_text', 'infoText'))
    };
  }

  /** 由任一筆 trip_date 與 day_label（如 "Day 3"）反推旅遊起始日 */
  function deriveTripStart(items) {
    for (const it of items) {
      const m = /(\d+)/.exec(it.dayLabel || '');
      if (m && /^\d{4}-\d{2}-\d{2}$/.test(it.tripDate)) {
        const [y, mo, d] = it.tripDate.split('-').map(Number);
        const dt = new Date(Date.UTC(y, mo - 1, d - (+m[1] - 1)));
        return dt.toISOString().slice(0, 10);
      }
    }
    return '';
  }

  function normalizeBundle(p) {
    p = p || {};
    const arr = (a, b) => (Array.isArray(p[a]) ? p[a] : Array.isArray(p[b]) ? p[b] : []);
    const itinerary = arr('itinerary').map(normalizeItem);
    return {
      itinerary,
      pocketSpots: arr('pocketSpots', 'pocket_spots').map(normalizePocket),
      tripMeta: arr('tripMeta', 'trip_meta').map(normalizeMeta),
      meta: Object.assign({ tripStartDate: deriveTripStart(itinerary) }, p.meta || {})
    };
  }

  /** 當日路線：sun+all 或 rain+all；無效 weather_mode 的列排除 */
  function buildDayRoute(items, date, mode) {
    const m = s(mode).toLowerCase() === 'rain' ? 'rain' : 'sun';
    return (items || []).map(normalizeItem)
      .filter((i) => i.tripDate === s(date) && !i.invalidWeather && (i.weatherMode === 'all' || i.weatherMode === m))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.slotId.localeCompare(b.slotId) || a.activityId.localeCompare(b.activityId))
      .map((i, idx) => Object.assign({}, i, { stepIndex: idx + 1, isWeatherAlternative: i.weatherMode !== 'all' }));
  }

  /** opts: { status:{id:'pending|done|skipped'}, actualEnd:{id:分鐘} } */
  function computeTimeline(route, opts) {
    const o = opts || {};
    const status = o.status || {};
    const actualEnd = o.actualEnd || {};
    const list = Array.isArray(route) ? route : [];
    let lastActive = -1;
    list.forEach((it, i) => { if ((status[it.activityId] || 'pending') !== 'skipped') lastActive = i; });
    let prevEnd = null, prevTravel = 0, prevBuffer = 0;

    return list.map((it, idx) => {
      const st = status[it.activityId] || 'pending';
      const base = Object.assign({}, it, { status: st });
      if (st === 'skipped') {
        return Object.assign(base, { startMin: null, departMin: null, deadlineAlert: null, hasMoveToNext: false, isLastStop: false,
          startFormatted: formatMinutes(null), departFormatted: formatMinutes(null), nextArrivalFormatted: formatMinutes(null) });
      }
      const isLast = idx === lastActive;
      const explicit = parseHHMM(it.startTime);
      const arrival = prevEnd === null ? null : prevEnd + prevTravel;
      const floor = prevEnd === null ? null : (it.timeType === 'fixed' ? arrival : arrival + prevBuffer);
      const cands = [floor, explicit].filter((v) => v !== null);
      const startMin = cands.length ? Math.max.apply(null, cands) : null;
      let endMin = startMin === null ? null : startMin + it.dwellMin;
      if (st === 'done' && Number.isFinite(actualEnd[it.activityId])) endMin = actualEnd[it.activityId];
      const travel = isLast ? 0 : it.travelMin;
      const buffer = isLast ? 0 : it.bufferMin;

      const dl = parseHHMM(it.deadlineTime);
      let deadlineAlert = null;
      if (dl !== null) {
        const actual = it.deadlineType === 'depart_by' ? endMin : (arrival !== null ? arrival : startMin);
        if (actual !== null) {
          deadlineAlert = { type: it.deadlineType || 'arrive_by', deadlineTime: it.deadlineTime,
            actualFormatted: formatMinutes(actual).text, isLate: actual > dl, diffMin: actual - dl };
        }
      }
      const nextArr = !isLast && endMin !== null ? endMin + travel + buffer : null;
      const row = Object.assign(base, {
        isLastStop: isLast, arrivalMin: arrival, startMin, departMin: endMin,
        delayMin: explicit !== null && startMin !== null ? startMin - explicit : 0,
        travelUsed: travel, bufferUsed: buffer, hasMoveToNext: !isLast, deadlineAlert,
        startFormatted: formatMinutes(startMin), departFormatted: formatMinutes(endMin),
        nextArrivalFormatted: formatMinutes(nextArr)
      });
      prevEnd = endMin; prevTravel = travel; prevBuffer = buffer;
      return row;
    });
  }

  function filterPocket(spots, f) {
    f = f || {};
    const area = s(f.area), io = s(f.indoorOutdoor).toLowerCase();
    return (spots || []).map(normalizePocket).filter((x) =>
      (!area || area === 'ALL' || x.area === area) && (!io || io === 'all' || x.indoorOutdoor === io));
  }

  const api = { parseHHMM, formatMinutes, normalizeItem, normalizePocket, normalizeMeta, normalizeBundle,
    deriveTripStart, buildDayRoute, computeTimeline, filterPocket };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TripEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
