/** @type {Object.<string, import("./defaults.js").ModelCost>} */
export let deepseekCost = {};
export function setDeepseekCost(value) {
    deepseekCost = value;
}

/** @type {import("./defaults.js").PeakTimes[]} */
export let peakTimes = [];
export function setPeakTimes(value) {
    peakTimes = value;
}

export const Statistic = {
    prompt: 0,
    cacheHit: 0,
    cacheMiss: 0,
    completion: 0,
    reasoning: 0,
    response: 0,
    total: 0,
};
export const Usage = {
    model: '',
    timestamp: 0,
    count: 0,
    tokens: structuredClone(Statistic),
    extra: structuredClone(Statistic),
};

export let accumulatedUsage = {
    requestCount: 0,

    /** @type {Object<string, Usage>} */
    models: {}
};

/** @type {accumulatedUsage} */
export let lifetimeUsage;
export function setLifetimeUsage(value) {
    lifetimeUsage = value;
}

/** @type {accumulatedUsage} */
export let sessionUsage;
export function setSessionUsage(value) {
    sessionUsage = value;
}

/** @type {Usage[]} */
export let sessionLog = [];
export function setSessionLog(value) {
    sessionLog = value;
}
