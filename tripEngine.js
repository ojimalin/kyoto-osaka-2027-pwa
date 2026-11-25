/**
 * ============================================================================
 * 檔案名稱：tripEngine.js
 * 檔案功能：2027 京阪旅遊 PWA 前端資料正規化、晴雨路線與時間軸推算純函式。
 * 設計原則：不修改傳入陣列、不依賴 DOM 或 localStorage，方便測試與替換 UI。
 * ============================================================================
 */

(function (global) {
  'use strict';

  const VALID_WEATHER_MODES = new Set(['sun', 'rain', 'all']);
  const VALID_INDOOR_OUTDOOR = new Set(['indoor', 'outdoor', 'mixed']);

  /**
   * 將字串安全轉為 trimmed 字串。
   * @param {*} val
   * @return {string}
   */
  function toStr(val) {
    if (val === null || val === undefined) return '';
    return String(val).trim();
  }

  /**
   * 將值安全轉為非負整數（無效或空值回傳 fallback）。
   * @param {*} val
   * @param {number} [fallback=0]
   * @return {number}
   */
  function toNonNegInt(val, fallback) {
    const def = typeof fallback === 'number' ? fallback : 0;
    if (val === null || val === undefined || val === '') return def;
    const num = Number(val);
    if (!Number.isFinite(num)) return def;
    const intVal = Math.trunc(num);
    return intVal >= 0 ? intVal : def;
  }

  /**
   * 解析 "HH:MM"（24 小時制）為當日分鐘數（0～1439）。
   * 若格式不符或超出範圍則回傳 null。
   * @param {*} timeStr
   * @return {number|null}
   */
  function parseHHMM(timeStr) {
    const s = toStr(timeStr);
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours * 60 + minutes;
  }

  /**
   * 將當日分鐘數格式化為 "HH:MM"，並標示是否跨日（>= 1440）或午夜前（< 0）。
   * @param {number|null|undefined} totalMinutes
   * @return {{ text: string, minutes: number|null, isNextDay: boolean, isPrevDay: boolean }}
   */
  function formatMinutes(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined || !Number.isFinite(Number(totalMinutes))) {
      return { text: '', minutes: null, isNextDay: false, isPrevDay: false };
    }
    const raw = Math.trunc(Number(totalMinutes));
    const isNextDay = raw >= 1440;
    const isPrevDay = raw < 0;
    const wrapped = ((raw % 1440) + 1440) % 1440;
    const hh = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const mm = String(wrapped % 60).padStart(2, '0');
    return {
      text: `${hh}:${mm}`,
      minutes: raw,
      isNextDay,
      isPrevDay
    };
  }

  /**
   * 正規化單筆 itinerary 標準表列。
   * @param {Object} raw
   * @return {Object}
   */
  function normalizeItineraryItem(raw) {
    const item = raw || {};
    const rawWeather = toStr(item.weather_mode ?? item.weatherMode).toLowerCase();
    const weatherMode = VALID_WEATHER_MODES.has(rawWeather) ? rawWeather : 'all';

    return {
      slotId: toStr(item.slot_id ?? item.slotId),
      tripDate: toStr(item.trip_date ?? item.tripDate),
      dayLabel: toStr(item.day_label ?? item.dayLabel),
      weatherMode,
      timeType: toStr(item.time_type ?? item.timeType) || 'flexible',
      startTime: toStr(item.start_time ?? item.startTime),
      deadlineTime: toStr(item.deadline_time ?? item.deadlineTime),
      deadlineType: toStr(item.deadline_type ?? item.deadlineType),
      dwellMin: toNonNegInt(item.dwell_min ?? item.dwellMin, 0),
      travelMin: toNonNegInt(item.travel_min ?? item.travelMin, 0),
      bufferMin: toNonNegInt(item.buffer_min ?? item.bufferMin, 0),
      transportMode: toStr(item.transport_mode ?? item.transportMode),
      area: toStr(item.area),
      sortOrder: toNonNegInt(item.sort_order ?? item.sortOrder, 0),
      activityId: toStr(item.activity_id ?? item.activityId),
      titleZh: toStr(item.title_zh ?? item.titleZh),
      titleJp: toStr(item.title_jp ?? item.titleJp),
      addressJp: toStr(item.address_jp ?? item.addressJp),
      coords: toStr(item.coords),
      note: toStr(item.note)
    };
  }

  /**
   * 正規化單筆 pocket_spots 標準表列。
   * @param {Object} raw
   * @return {Object}
   */
  function normalizePocketSpot(raw) {
    const spot = raw || {};
    const rawIO = toStr(spot.indoor_outdoor ?? spot.indoorOutdoor).toLowerCase();
    const indoorOutdoor = VALID_INDOOR_OUTDOOR.has(rawIO) ? rawIO : 'mixed';

    return {
      pocketId: toStr(spot.pocket_id ?? spot.pocketId),
      area: toStr(spot.area),
      indoorOutdoor,
      defaultDwellMin: toNonNegInt(spot.default_dwell_min ?? spot.defaultDwellMin, 0),
      defaultTravelMin: toNonNegInt(spot.default_travel_min ?? spot.defaultTravelMin, 0),
      transportMode: toStr(spot.transport_mode ?? spot.transportMode),
      titleZh: toStr(spot.title_zh ?? spot.titleZh),
      titleJp: toStr(spot.title_jp ?? spot.titleJp),
      addressJp: toStr(spot.address_jp ?? spot.addressJp),
      coords: toStr(spot.coords),
      note: toStr(spot.note)
    };
  }

  /**
   * 正規化單筆 trip_meta 標準表列。
   * @param {Object} raw
   * @return {Object}
   */
  function normalizeTripMeta(raw) {
    const meta = raw || {};
    return {
      metaId: toStr(meta.meta_id ?? meta.metaId),
      tripDate: toStr(meta.trip_date ?? meta.tripDate),
      category: toStr(meta.category),
      titleZh: toStr(meta.title_zh ?? meta.titleZh),
      titleJp: toStr(meta.title_jp ?? meta.titleJp),
      addressJp: toStr(meta.address_jp ?? meta.addressJp),
      infoText: toStr(meta.info_text ?? meta.infoText)
    };
  }

  /**
   * 將三張標準表原始陣列正規化為前端統一資料包。
   * @param {{ itinerary?: Array, pocketSpots?: Array, tripMeta?: Array, meta?: Object }} payload
   * @return {{ itinerary: Array, pocketSpots: Array, tripMeta: Array, meta: Object }}
   */
  function normalizeTripBundle(payload) {
    const src = payload || {};
    const rawItinerary = Array.isArray(src.itinerary) ? src.itinerary : [];
    const rawPocket = Array.isArray(src.pocketSpots ?? src.pocket_spots) ? (src.pocketSpots ?? src.pocket_spots) : [];
    const rawTripMeta = Array.isArray(src.tripMeta ?? src.trip_meta) ? (src.tripMeta ?? src.trip_meta) : [];

    return {
      itinerary: rawItinerary.map(normalizeItineraryItem),
      pocketSpots: rawPocket.map(normalizePocketSpot),
      tripMeta: rawTripMeta.map(normalizeTripMeta),
      meta: Object.assign({}, src.meta || {})
    };
  }

  /**
   * 依指定日期與天氣模式（'sun' | 'rain'）建構當日路線。
   * 同 slotId 且相同 sortOrder 的 sun / rain 項目會依所選天氣原位替換，all 項目保留原位。
   * @param {Array<Object>} itineraryItems
   * @param {string} tripDate
   * @param {'sun'|'rain'} [weatherMode='sun']
   * @return {Array<Object>}
   */
  function buildDayRoute(itineraryItems, tripDate, weatherMode) {
    const targetDate = toStr(tripDate);
    const mode = toStr(weatherMode).toLowerCase() === 'rain' ? 'rain' : 'sun';
    const normalized = (Array.isArray(itineraryItems) ? itineraryItems : [])
      .map(normalizeItineraryItem)
      .filter((item) => item.tripDate === targetDate);

    const filtered = normalized.filter((item) => {
      if (item.weatherMode === 'all') return true;
      return item.weatherMode === mode;
    });

    filtered.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      if (a.slotId !== b.slotId) return a.slotId.localeCompare(b.slotId);
      return a.activityId.localeCompare(b.activityId);
    });

    return filtered.map((item, idx) => ({
      ...item,
      stepIndex: idx + 1,
      activeWeatherMode: mode,
      isWeatherAlternative: item.weatherMode !== 'all'
    }));
  }

  /**
   * 推算單日路線的時間軸、移動銜接與固定卡點（deadline_time）狀態。
   * @param {Array<Object>} routeItems 已排序的當日路線項目
   * @return {Array<Object>}
   */
  function computeTimeline(routeItems) {
    const list = Array.isArray(routeItems) ? routeItems : [];
    let cursorArrivalMin = null;

    return list.map((rawItem, idx) => {
      const item = normalizeItineraryItem(rawItem);
      const explicitStartMin = parseHHMM(item.startTime);

      let startMin = explicitStartMin;
      let startSource = explicitStartMin !== null ? 'explicit' : 'none';

      if (startMin === null && cursorArrivalMin !== null) {
        startMin = cursorArrivalMin;
        startSource = 'chained';
      }

      const departMin = startMin !== null ? startMin + item.dwellMin : null;
      const totalMoveMin = item.travelMin + item.bufferMin;
      const nextArrivalMin = departMin !== null ? departMin + totalMoveMin : null;

      // 固定時間卡點檢核（支援 arrive_by 與 depart_by）
      const deadlineMin = parseHHMM(item.deadlineTime);
      let deadlineAlert = null;
      if (deadlineMin !== null) {
        if (item.deadlineType === 'depart_by' && departMin !== null) {
          const diffMin = departMin - deadlineMin;
          deadlineAlert = {
            type: 'depart_by',
            deadlineTime: item.deadlineTime,
            actualMinutes: departMin,
            actualFormatted: formatMinutes(departMin).text,
            isLate: diffMin > 0,
            diffMin // 正數代表超過截止時間幾分鐘
          };
        } else if (startMin !== null) {
          // 預設或 arrive_by：比對抵達／開始時間與截止時間
          const diffMin = startMin - deadlineMin;
          deadlineAlert = {
            type: item.deadlineType || 'arrive_by',
            deadlineTime: item.deadlineTime,
            actualMinutes: startMin,
            actualFormatted: formatMinutes(startMin).text,
            isLate: diffMin > 0,
            diffMin
          };
        }
      }

      const hasMoveToNext = idx < list.length - 1 || totalMoveMin > 0 || Boolean(item.transportMode);
      cursorArrivalMin = nextArrivalMin;

      return {
        ...item,
        stepIndex: rawItem.stepIndex ?? idx + 1,
        activeWeatherMode: rawItem.activeWeatherMode ?? (item.weatherMode === 'rain' ? 'rain' : 'sun'),
        isWeatherAlternative: Boolean(rawItem.isWeatherAlternative ?? (item.weatherMode !== 'all')),
        startMin,
        startSource,
        startFormatted: formatMinutes(startMin),
        departMin,
        departFormatted: formatMinutes(departMin),
        totalMoveMin,
        nextArrivalMin,
        nextArrivalFormatted: formatMinutes(nextArrivalMin),
        hasMoveToNext,
        deadlineAlert
      };
    });
  }

  /**
   * 篩選備選口袋（pocket_spots）。
   * @param {Array<Object>} pocketSpots
   * @param {{ area?: string, indoorOutdoor?: string, keyword?: string }} [filter]
   * @return {Array<Object>}
   */
  function filterPocketSpots(pocketSpots, filter) {
    const f = filter || {};
    const areaFilter = toStr(f.area);
    const ioFilter = toStr(f.indoorOutdoor).toLowerCase();
    const kw = toStr(f.keyword).toLowerCase();

    return (Array.isArray(pocketSpots) ? pocketSpots : [])
      .map(normalizePocketSpot)
      .filter((spot) => {
        if (areaFilter && areaFilter !== 'ALL' && spot.area !== areaFilter) return false;
        if (ioFilter && ioFilter !== 'all' && spot.indoorOutdoor !== ioFilter) return false;
        if (kw) {
          const hay = `${spot.titleZh} ${spot.titleJp} ${spot.area} ${spot.note}`.toLowerCase();
          if (!hay.includes(kw)) return false;
        }
        return true;
      });
  }

  const api = {
    parseHHMM,
    formatMinutes,
    normalizeItineraryItem,
    normalizePocketSpot,
    normalizeTripMeta,
    normalizeTripBundle,
    buildDayRoute,
    computeTimeline,
    filterPocketSpots
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.TripEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);

