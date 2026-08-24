/**
 * @typedef {Object} ModelCost
 * @property {number} in
 * @property {number} cached
 * @property {number} out
 */

/** @type {ModelCost} */
export const DEFAULT_COST = {
    in: 0.0,
    cached: 0.0,
    out: 0.0,
};

// Default prices, as fallback
// Need to update this when DS's price updates
// https://api-docs.deepseek.com/quick_start/pricing
/** @type {Object.<string, ModelCost>} */
export const DEFAULT_DEEPSEEK_COST = {
    "deepseek-v4-flash": {
        in: 0.22,
        cached: 0.007,
        out: 0.66,
    },
    "deepseek-v4-pro": {
        in: 0.66,
        cached: 0.022,
        out: 1.98,
    },
};

/**
 * @type {string[]}
 */
export const PEAK_WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * @typedef {Object} WeekDayActive
 * @property {boolean} sun
 * @property {boolean} mon
 * @property {boolean} tue
 * @property {boolean} wed
 * @property {boolean} thu
 * @property {boolean} fri
 * @property {boolean} sat
*/

// Fallback weekdays, also used when migrating old saved data.
/** @type {WeekDayActive} */
export const DEFAULT_PEAK_WEEKDAYS = {
    sun: true,
    mon: true,
    tue: true,
    wed: true,
    thu: true,
    fri: true,
    sat: true,
};

/**
 * @typedef {Object} PeakTimes
 * @property {string} start
 * @property {string} end
 * @property {WeekDayActive} weekdays
 */

/** @type {PeakTimes[]} */
export const DEFAULT_PEAK_TIMES = [
    // UTC times. DeepSeek: off-peak rates apply all day on weekends (Sat/Sun).
    { start: "01:00", end: "04:00", weekdays: { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false } },
    { start: "06:00", end: "10:00", weekdays: { sun: false, mon: true, tue: true, wed: true, thu: true, fri: true, sat: false } },
];
