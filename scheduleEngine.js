// scheduleEngine.js
// Decouples day departure override (manual vs. baseline/settings default), fixed vs. flexible time handling,
// per-card start_time override/reset, and insert-before / insert-after placement for extra stops.

(function (global) {
  "use strict";

  const DEFAULT_FALLBACK_START = "07:30";

  function parseHHMM(hhmm) {
    if (typeof hhmm !== "string") return null;
    const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function formatMinutesToHHMM(totalMin) {
    const mins = ((Math.round(Number(totalMin)) % 1440) + 1440) % 1440;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  function isValidHHMM(val) {
    return parseHHMM(val) !== null;
  }

  function normalizeTimeType(raw) {
    const s = String(raw || "").trim();
    if (s === "固定抵達" || s === "fixed_arrival") return "fixed_arrival";
    if (s === "固定出發" || s === "fixed_departure") return "fixed_departure";
    if (s === "fixed") return "fixed_arrival";
    return "flexible";
  }

  /**
   * Resolves manual day-start override from runtime_state map/object.
   * Key format: start:<trip_date>
   */
  function getManualDayStartOverride(runtimeState, tripDate) {
    if (!runtimeState || !tripDate) return null;
    const key = "start:" + tripDate;
    let raw = null;
    if (runtimeState instanceof Map) {
      raw = runtimeState.get(key);
    } else if (typeof runtimeState === "object") {
      raw = runtimeState[key];
    }
    if (!raw) return null;
    if (typeof raw === "string") {
      return isValidHHMM(raw) ? { time: raw.trim(), manual: true } : null;
    }
    if (typeof raw === "object" && isValidHHMM(raw.time)) {
      return {
        time: raw.time.trim(),
        manual: raw.manual !== false,
        updatedAt: raw.updatedAt || null
      };
    }
    return null;
  }

  /**
   * Determines effective start time for a day without mutating baseline data:
   * 1. Manual override (start:<trip_date>) if set by user -> source: "manual_override"
   * 2. First active item's baseline/override start_time if valid HH:MM -> source: "baseline_first_item"
   * 3. Settings default start time (settingsDefaultStart || "07:30") -> source: "settings_default"
   */
  function resolveDayStartInfo(options) {
    const {
      tripDate,
      items = [],
      runtimeState = null,
      settingsDefaultStart = null,
      defaultStart = DEFAULT_FALLBACK_START
    } = options || {};

    const resolvedSettingsDefault = isValidHHMM(settingsDefaultStart)
      ? String(settingsDefaultStart).trim()
      : (isValidHHMM(defaultStart) ? String(defaultStart).trim() : DEFAULT_FALLBACK_START);

    const manual = getManualDayStartOverride(runtimeState, tripDate);
    if (manual) {
      return {
        startHHMM: manual.time,
        settingsDefaultHHMM: resolvedSettingsDefault,
        source: "manual_override",
        isManualOverride: true
      };
    }

    const firstWithTime = (items || []).find(
      (it) => it && it.status !== "skipped" && isValidHHMM(it.effective_start_time ?? it.start_time)
    );
    if (firstWithTime) {
      const val = String(firstWithTime.effective_start_time ?? firstWithTime.start_time).trim();
      return {
        startHHMM: val,
        settingsDefaultHHMM: resolvedSettingsDefault,
        source: "baseline_first_item",
        isManualOverride: false
      };
    }

    return {
      startHHMM: resolvedSettingsDefault,
      settingsDefaultHHMM: resolvedSettingsDefault,
      source: "settings_default",
      isManualOverride: false
    };
  }

  /**
   * Builds ordered list for a given day, supporting:
   * - baseline items (preserving baseline order)
   * - extra items (extra:<trip_date>) with placement: "before" | "after" relative to anchor_id (or anchor_activity_id)
   */
  function mergeDayItemsWithExtras(baseItems = [], extraItems = []) {
    const result = baseItems.map((it, idx) => ({
      ...it,
      _origin: it._origin || "baseline",
      _baseIndex: idx
    }));

    const extras = Array.isArray(extraItems) ? [...extraItems] : [];
    extras.sort((a, b) => {
      const seqA = Number(a._insertSeq ?? 0);
      const seqB = Number(b._insertSeq ?? 0);
      if (seqA !== seqB) return seqA - seqB;
      return String(a._createdAt || "").localeCompare(String(b._createdAt || ""));
    });

    for (const ex of extras) {
      const placement = ex._placement === "before" ? "before" : "after";
      const anchorKey = ex._anchorId || ex._anchorActivityId || null;

      let anchorIdx = -1;
      if (anchorKey) {
        anchorIdx = result.findIndex(
          (row) => row.activity_id === anchorKey || row.slot_id === anchorKey || row._id === anchorKey
        );
      }

      const clonedEx = {
        ...ex,
        _origin: "extra"
      };

      if (anchorIdx === -1) {
        if (placement === "before") {
          result.unshift(clonedEx);
        } else {
          result.push(clonedEx);
        }
      } else if (placement === "before") {
        result.splice(anchorIdx, 0, clonedEx);
      } else {
        result.splice(anchorIdx + 1, 0, clonedEx);
      }
    }

    return result;
  }

  /**
   * Computes schedule times for a single day's items using the settings page default start time
   * whenever neither a manual day-start override nor a first-item start_time applies.
   */
  function computeDaySchedule(options) {
    const {
      tripDate,
      baseItems = [],
      extraItems = [],
      localOverrides = {},
      runtimeState = null,
      settingsDefaultStart = null,
      defaultStart = DEFAULT_FALLBACK_START
    } = options || {};

    const merged = mergeDayItemsWithExtras(baseItems, extraItems).map((item) => {
      const key = item.activity_id || item.slot_id;
      const ov = (key && localOverrides && localOverrides[key]) ? localOverrides[key] : null;
      const fields = (ov && ov.fields) ? ov.fields : (ov || {});

      const hasStartOverride = Object.prototype.hasOwnProperty.call(fields, "start_time");
      const rawStart = hasStartOverride ? fields.start_time : item.start_time;
      const effectiveStart = (typeof rawStart === "string" && isValidHHMM(rawStart)) ? rawStart.trim() : "";

      return {
        ...item,
        start_time: item.start_time || "",
        effective_start_time: effectiveStart,
        has_start_override: hasStartOverride,
        dwell_min: Number(fields.dwell_min ?? item.dwell_min ?? 0) || 0,
        travel_min: Number(fields.travel_min ?? item.travel_min ?? 0) || 0,
        buffer_min: Number(fields.buffer_min ?? item.buffer_min ?? 0) || 0,
        transport_mode: fields.transport_mode ?? item.transport_mode ?? "",
        note: fields.note ?? item.note ?? ""
      };
    });

    const startInfo = resolveDayStartInfo({
      tripDate,
      items: merged,
      runtimeState,
      settingsDefaultStart,
      defaultStart
    });

    let cursorMin = parseHHMM(startInfo.startHHMM);
    if (cursorMin === null) cursorMin = parseHHMM(startInfo.settingsDefaultHHMM);

    let isFirstActive = true;
    const scheduled = merged.map((item) => {
      if (item.status === "skipped") {
        return {
          ...item,
          computed_start: item.effective_start_time || item.start_time || "",
          computed_end: "",
          wait_min: 0,
          is_late: false,
          skipped: true
        };
      }

      const timeType = normalizeTimeType(item.time_type);
      const cardExplicitMin = isValidHHMM(item.effective_start_time)
        ? parseHHMM(item.effective_start_time)
        : null;
      const deadlineMin = isValidHHMM(item.deadline_time)
        ? parseHHMM(item.deadline_time)
        : null;

      let arrivalOrStartMin;
      let waitMin = 0;
      let isLate = false;

      if (isFirstActive) {
        if (startInfo.isManualOverride) {
          arrivalOrStartMin = cursorMin;
          if (timeType !== "flexible" && cardExplicitMin !== null && cardExplicitMin > arrivalOrStartMin) {
            waitMin = cardExplicitMin - arrivalOrStartMin;
            arrivalOrStartMin = cardExplicitMin;
          }
        } else if (cardExplicitMin !== null) {
          arrivalOrStartMin = cardExplicitMin;
        } else {
          arrivalOrStartMin = cursorMin;
        }
        isFirstActive = false;
      } else {
        const estimatedArrival = cursorMin;
        if (timeType === "fixed_arrival" || timeType === "fixed_departure") {
          if (cardExplicitMin !== null) {
            if (estimatedArrival < cardExplicitMin) {
              waitMin = cardExplicitMin - estimatedArrival;
              arrivalOrStartMin = cardExplicitMin;
            } else {
              arrivalOrStartMin = estimatedArrival;
              if (estimatedArrival > cardExplicitMin) {
                isLate = true;
              }
            }
          } else {
            arrivalOrStartMin = estimatedArrival;
          }
        } else {
          if (cardExplicitMin !== null && cardExplicitMin > estimatedArrival) {
            arrivalOrStartMin = cardExplicitMin;
          } else {
            arrivalOrStartMin = estimatedArrival;
          }
        }
      }

      if (deadlineMin !== null && arrivalOrStartMin > deadlineMin) {
        isLate = true;
      }

      const endMin = arrivalOrStartMin + item.dwell_min;
      const nextCursorMin = endMin + item.travel_min + item.buffer_min;
      cursorMin = nextCursorMin;

      return {
        ...item,
        time_type_normalized: timeType,
        computed_start: formatMinutesToHHMM(arrivalOrStartMin),
        computed_end: formatMinutesToHHMM(endMin),
        next_cursor: formatMinutesToHHMM(nextCursorMin),
        wait_min: waitMin,
        is_late: isLate,
        skipped: false
      };
    });

    return {
      tripDate,
      dayStartHHMM: startInfo.startHHMM,
      settingsDefaultHHMM: startInfo.settingsDefaultHHMM,
      dayStartSource: startInfo.source,
      isManualDayStart: startInfo.isManualOverride,
      items: scheduled
    };
  }

  const api = {
    DEFAULT_FALLBACK_START,
    parseHHMM,
    formatMinutesToHHMM,
    isValidHHMM,
    normalizeTimeType,
    getManualDayStartOverride,
    resolveDayStartInfo,
    mergeDayItemsWithExtras,
    computeDaySchedule
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.ScheduleEngine = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
