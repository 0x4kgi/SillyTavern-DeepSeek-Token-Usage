import { EXT_PREFIX } from "./constants.js";
import {
    DEFAULT_DEEPSEEK_COST, DEFAULT_PEAK_TIMES, DEFAULT_PEAK_WEEKDAYS,
    PEAK_WEEKDAY_KEYS,
} from "./defaults.js";
import {
    Statistic, Usage,
    accumulatedUsage, lifetimeUsage, deepseekCost, peakTimes
} from "./globals.js";
import { log, debounce, timeToInt } from "./utils.js";

function fetchFromLocalStorage(key, defaultValue) {
    const raw = localStorage.getItem(`${EXT_PREFIX}${key}`);
    let data;

    if (!raw) {
        log.warn(`No ${key} stats saved.`)
        data = structuredClone(defaultValue);
    } else {
        try {
            data = JSON.parse(raw);
        } catch (error) {
            log.warn(`Corrupt ${key} stats, using defaults.`, error);
            data = structuredClone(defaultValue);
        }
    }

    return data;
}
export function fetchLifetimeUsageFromLocalStorage() {
    log("Fetching localStorage for saved stats.");

    let data = fetchFromLocalStorage("lifetimeUsage", accumulatedUsage);

    Object.keys(deepseekCost).forEach(modelName => {
        if (!data.models[modelName]) {
            data.models[modelName] = structuredClone(Usage);
        }
    });

    // Migration from old data.
    // New fields must go here, refer to <Usage>
    Object.keys(data.models).forEach(modelName => {
        data.models[modelName].extra ??= structuredClone(Statistic);
    });

    return data;
}
export function saveLifetimeUsageToLocalStorage() {
    log("Saving lifetimeUsage.");

    let _lifetimeUsage = structuredClone(lifetimeUsage);

    log("What to save: ", _lifetimeUsage);

    localStorage.setItem(`${EXT_PREFIX}lifetimeUsage`, JSON.stringify(_lifetimeUsage));
}
export function fetchDeepSeekCostFromLocalStorage() {
    log("Fetching localStorage for saved prices.");

    let data = fetchFromLocalStorage("deepseekCost", DEFAULT_DEEPSEEK_COST);

    Object.keys(DEFAULT_DEEPSEEK_COST).forEach(modelName => {
        if (!data[modelName]) {
            data[modelName] = structuredClone(DEFAULT_DEEPSEEK_COST[modelName]);
        }
    });

    return data;
}
export const saveDeepSeekCostToLocalStorageDebounced = debounce(saveDeepSeekCostToLocalStorage, 1000);
function saveDeepSeekCostToLocalStorage() {
    log("Saving deepseekCost.");

    let _deepSeekCost = structuredClone(deepseekCost);

    log("What to save: ", _deepSeekCost);

    localStorage.setItem(`${EXT_PREFIX}deepseekCost`, JSON.stringify(_deepSeekCost));
}
export function fetchPeakTimesFromLocalStorage() {
    log("Fetching localStorage for saved times.");

    let data = fetchFromLocalStorage("deepseekPeakTimes", DEFAULT_PEAK_TIMES);

    if (!Array.isArray(data)) {
        log.warn("Saved peak times are not an array, using defaults.");
        return structuredClone(DEFAULT_PEAK_TIMES);
    }

    data = data.map(normalizePeakTime).filter(Boolean);

    return data;
}
/**
 * Accepts both the old [start, end] array format and the new { start, end, weekdays } object format.
 * Old arrays migrate to every-day weekdays to keep the previous behavior.
 *
 * @param {any} entry
 * @returns {{ start: string, end: string, weekdays: Object } | null}
 */
function normalizePeakTime(entry) {
    let start;
    let end;
    let weekdays;

    if (Array.isArray(entry)) {
        [start, end] = entry;
        weekdays = structuredClone(DEFAULT_PEAK_WEEKDAYS);
    } else if (entry && typeof entry === "object") {
        start = entry.start;
        end = entry.end;
        weekdays = { ...DEFAULT_PEAK_WEEKDAYS, ...entry.weekdays };
    } else {
        return null;
    }

    if (typeof start !== "string" || typeof end !== "string") return null;
    if (Number.isNaN(timeToInt(start)) || Number.isNaN(timeToInt(end))) return null;

    PEAK_WEEKDAY_KEYS.forEach(day => {
        weekdays[day] = weekdays[day] === true;
    });

    return { start, end, weekdays };
}
export const savePeakTimesToLocalStorageDebounced = debounce(savePeakTimesToLocalStorage, 1000);
function savePeakTimesToLocalStorage() {
    log("Saving peakTimes.");

    let _peakTimes = structuredClone(peakTimes);

    log("What to save: ", _peakTimes);

    localStorage.setItem(`${EXT_PREFIX}deepseekPeakTimes`, JSON.stringify(_peakTimes));
}
