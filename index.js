import {
    EXTENSION_NAME,
    EXTENSION_FOLDER_PATH,
    EXT_PREFIX,
} from "./src/constants.js";
import {
    DEFAULT_COST,
    DEFAULT_DEEPSEEK_COST,
    PEAK_WEEKDAY_KEYS,
    DEFAULT_PEAK_WEEKDAYS,
    DEFAULT_PEAK_TIMES,
} from "./src/defaults.js"
import {
    Statistic, Usage,
    deepseekCost, peakTimes,
    setDeepseekCost, setPeakTimes,
    accumulatedUsage, lifetimeUsage, sessionUsage, sessionLog,
    setLifetimeUsage, setSessionLog, setSessionUsage,
} from "./src/globals.js";
import {
    log, debounce
} from "./src/utils.js";

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
function fetchLifetimeUsageFromLocalStorage() {
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
function saveLifetimeUsageToLocalStorage() {
    log("Saving lifetimeUsage.");

    let _lifetimeUsage = structuredClone(lifetimeUsage);

    log("What to save: ", _lifetimeUsage);

    localStorage.setItem(`${EXT_PREFIX}lifetimeUsage`, JSON.stringify(_lifetimeUsage));
}
function fetchDeepSeekCostFromLocalStorage() {
    log("Fetching localStorage for saved prices.");

    let data = fetchFromLocalStorage("deepseekCost", DEFAULT_DEEPSEEK_COST);

    Object.keys(DEFAULT_DEEPSEEK_COST).forEach(modelName => {
        if (!data[modelName]) {
            data[modelName] = structuredClone(DEFAULT_DEEPSEEK_COST[modelName]);
        }
    });

    return data;
}
const saveDeepSeekCostToLocalStorageDebounced = debounce(saveDeepSeekCostToLocalStorage, 1000);
function saveDeepSeekCostToLocalStorage() {
    log("Saving deepseekCost.");

    let _deepSeekCost = structuredClone(deepseekCost);

    log("What to save: ", _deepSeekCost);

    localStorage.setItem(`${EXT_PREFIX}deepseekCost`, JSON.stringify(_deepSeekCost));
}
function fetchPeakTimesFromLocalStorage() {
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
const savePeakTimesToLocalStorageDebounced = debounce(savePeakTimesToLocalStorage, 1000);
function savePeakTimesToLocalStorage() {
    log("Saving peakTimes.");

    let _peakTimes = structuredClone(peakTimes);

    log("What to save: ", _peakTimes);

    localStorage.setItem(`${EXT_PREFIX}deepseekPeakTimes`, JSON.stringify(_peakTimes));
}

function overrideFetch() {
    log("Patching window.fetch");

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const url = args[0];
        const requestBody = args[1];

        const isGenerateUrl = typeof url === 'string'
            && url.includes('/api/backends/chat-completions/generate');
        if (!isGenerateUrl) {
            return originalFetch.apply(this, args);
        }

        const response = await originalFetch.apply(this, args);

        try {
            handleResponse(response, requestBody)
        } catch (error) {
            log.error("Error intercepting fetch:", error);
        }

        return response;
    };
}
async function handleResponse(response, requestBody) {
    const clonedResponse = response.clone();

    const requestJson = JSON.parse(requestBody?.body);
    const completionSource = requestJson.chat_completion_source ?? null;

    const responseType = response.headers.get("Content-Type") ?? "";
    const isStreaming = !responseType.includes("application/json");

    // since this is only useful for deepseek for now...
    if (completionSource !== "deepseek") return;

    let result;

    if (isStreaming) {
        log("Response is streaming!");
        result = await handleStream(clonedResponse.body);
    } else {
        log("Response in non-streaming!");
        const responseJson = await clonedResponse.json();
        result = await handleNonStream(responseJson);
    }

    if (result && result.usage) {
        processUsageData(result.usage, result.model);
    }
}
async function handleStream(stream) {
    if (!stream) return;

    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    let lastUsage;
    let lastModel;

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                const result = handleStreamLine(line);
                if (result) {
                    lastUsage = result.usage;
                    lastModel = result.model;
                }
            }
        }
    } catch (err) {
        log.error("Error reading stream:", err);
    }

    return {
        usage: lastUsage,
        model: lastModel,
    }
}
function handleStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const jsonString = trimmed.replace(/^data:\s*/, "");
    if (jsonString === "[DONE]" || !jsonString) return;

    try {
        const parsed = JSON.parse(jsonString);
        if (parsed && parsed.usage) {
            log("Found Usage Data:", parsed.model, parsed.usage);
            return {
                usage: parsed.usage,
                model: parsed.model,
            };
        }
    } catch (_) { }
}
async function handleNonStream(data) {
    if (!data) return;

    if (data.usage) {
        log("Found Usage Data:", data.model, data.usage);
        return {
            usage: data.usage,
            model: data.model,
        }
    } else {
        log.warn("Response does not include usage data.");
    }
}

/**
 *
 * @param {any} usage
 * @returns {Statistic}
 */
function parseUsageObject(usage) {
    log("Parsing Usage Object...");
    const obj = {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
        response: 0,
        cacheHit: usage.prompt_cache_hit_tokens || 0,
        cacheMiss: usage.prompt_cache_miss_tokens || 0,
        ratio: 0,
    };
    obj.response = obj.completion - obj.reasoning;

    return obj;
}

/**
 *
 * @param {Statistic} tokens
 * @param {string} modelName
 * @returns {Statistic}
 */
function calculateTokenCost(tokens, modelName) {
    const tokenPrice = deepseekCost[modelName];

    if (!tokens || !tokenPrice) {
        return structuredClone(Statistic);
    }

    const cacheHitCost = tokenPrice.cached / 1_000_000;
    const cacheMissCost = tokenPrice.in / 1_000_000;
    const outputCost = tokenPrice.out / 1_000_000;

    const obj = {
        prompt: 0,
        cacheHit: tokens.cacheHit * cacheHitCost,
        cacheMiss: tokens.cacheMiss * cacheMissCost,
        completion: tokens.completion * outputCost,
        reasoning: tokens.reasoning * outputCost,
        response: tokens.response * outputCost,
        total: 0,
    };
    obj.prompt = obj.cacheHit + obj.cacheMiss;
    obj.total = obj.prompt + obj.completion;

    return obj;
}

/**
 *
 * @param {accumulatedUsage} usageLog
 * @param {Statistic} tokens
 * @param {string} model
 * @param {array} activePeakHours
 */
function saveAggregatedUsage(usageLog, tokens, model, activePeakHours) {
    let modelObject = usageLog.models[model] || structuredClone(Usage);

    modelObject.model = model;
    modelObject.timestamp = Date.now();
    modelObject.count += 1;

    Object.keys(tokens).forEach(parameter => {
        modelObject.tokens[parameter] += tokens[parameter];
        if (activePeakHours.length) {
            modelObject.extra[parameter] += tokens[parameter];
        }
    });

    usageLog.requestCount += 1;
    usageLog.models[model] = modelObject;
}

function processUsageData(usage, model) {
    if (!usage) return;
    log("Processing Usage data for display.");

    const activePeakHours = getActivatedPeakHours();

    const tokens = parseUsageObject(usage);
    const extra = activePeakHours.length ? structuredClone(tokens) : structuredClone(Statistic);

    saveAggregatedUsage(sessionUsage, tokens, model, activePeakHours);
    saveAggregatedUsage(lifetimeUsage, tokens, model, activePeakHours);

    sessionLog.push({
        model: model,
        timestamp: Date.now(),
        count: 1,
        tokens: { ...tokens },
        extra: { ...extra },
    });

    saveLifetimeUsageToLocalStorage();

    renderUIDebounced();
}

/**
 *
 * @param {accumulatedUsage} source
 * @returns {Usage}
 */
function getAllModelStats(source) {
    let accumulated = structuredClone(Usage);
    accumulated.cost ??= structuredClone(Statistic);
    accumulated.extraCost ??= structuredClone(Statistic);

    Object.keys(source.models).forEach(modelName => {
        const modelStats = source.models[modelName];
        Object.keys(modelStats.tokens).forEach(param => {
            accumulated.tokens[param] += modelStats.tokens[param];
        });

        const tokenCost = calculateTokenCost(modelStats.tokens, modelName);
        const extraCost = calculateTokenCost(modelStats.extra, modelName);

        Object.keys(tokenCost).forEach(param => {
            accumulated.cost[param] += tokenCost[param];
            accumulated.extraCost[param] += extraCost[param];
        });
    });

    return accumulated;
}

function numberComma(number) {
    return number.toLocaleString();
}

function updateLastGenerationStats() {
    const selectedModel = panelElemId("modelSelector").value;

    let tokens;
    let extra;
    let tokenCost;
    let extraCost;
    let modelName;
    let lastLog;

    if (selectedModel === "all") {
        lastLog = sessionLog[sessionLog.length - 1];
        modelName = lastLog ? lastLog.model : "deepseek-*";
    } else {
        let filtered = sessionLog.filter(usageLog => usageLog.model === selectedModel);
        lastLog = filtered[filtered.length - 1];
        modelName = selectedModel;
    }

    tokens = lastLog ? lastLog.tokens : structuredClone(Statistic);
    extra = lastLog ? lastLog.extra : structuredClone(Statistic);
    tokenCost = calculateTokenCost(tokens, modelName);
    extraCost = calculateTokenCost(extra, modelName);

    const ratio = tokens.prompt > 0 ?
        (tokens.cacheHit / tokens.prompt) * 100
        : 0;
    const displayTotalCost = tokenCost.total + extraCost.total;

    // Last Message
    panelElemText('prompt', numberComma(tokens.prompt));
    panelElemText('completion', numberComma(tokens.completion));
    panelElemText('total', numberComma(tokens.total));
    panelElemText('totalCost', displayTotalCost.toFixed(5));

    panelElemText('reasoning', numberComma(tokens.reasoning));
    panelElemText('response', numberComma(tokens.response));

    panelElemText('cacheHit', numberComma(tokens.cacheHit));
    panelElemText('cacheMiss', numberComma(tokens.cacheMiss));
    panelElemId('ratio').value = ratio;
    panelElemText('model', modelName);

    showLastOnMessage({modelName, tokens, ratio});
}
function updateNonLastStatsOnPanel(statType = "session") {
    /** @type {Usage} */
    let stat;
    let requestCount;

    /** @type {accumulatedUsage} */
    let sourceStat;

    const selectedModel = panelElemId("modelSelector").value;

    if (statType === "session") {
        sourceStat = structuredClone(sessionUsage);
    } else if (statType === "lifetime") {
        sourceStat = structuredClone(lifetimeUsage);
    } else {
        log.warn("Not valid statType:", statType);
        return;
    }

    requestCount = sourceStat.requestCount;

    if (selectedModel === "all") {
        stat = getAllModelStats(sourceStat);
        // stat.cost and stat.extraCost is handled by the function above
    } else {
        stat = sourceStat.models[selectedModel] || structuredClone(Usage);
        stat.cost = calculateTokenCost(stat.tokens, selectedModel);
        stat.extraCost = calculateTokenCost(stat.extra, selectedModel);
        requestCount = stat.count; // override when specific model, ig.
    }

    const ratio = stat.tokens.prompt > 0 ?
        (stat.tokens.cacheHit / stat.tokens.prompt) * 100
        : 0;
    const totalCost = stat.cost.total + stat.extraCost.total;

    panelElemText(`${statType}_prompt`, numberComma(stat.tokens.prompt));
    panelElemText(`${statType}_completion`, numberComma(stat.tokens.completion));
    panelElemText(`${statType}_total`, numberComma(stat.tokens.total));
    panelElemText(`${statType}_totalCost`, `${totalCost.toFixed(5)}`);

    panelElemText(`${statType}_reasoning`, numberComma(stat.tokens.reasoning));
    panelElemText(`${statType}_response`, numberComma(stat.tokens.response));

    panelElemText(`${statType}_cacheHit`, numberComma(stat.tokens.cacheHit));
    panelElemText(`${statType}_cacheMiss`, numberComma(stat.tokens.cacheMiss));

    panelElemId(`${statType}_ratio`).value = ratio;
    panelElemText(`${statType}_requestCount`, numberComma(requestCount));
}
function updateSessionLogBarChart() {
    const chart = panelElemId("session_chart");
    if (!chart) return;

    chart.innerHTML = "";

    const selectedModel = panelElemId("modelSelector").value;

    let logs = sessionLog;
    if (selectedModel !== "all") {
        logs = logs.filter(log => log.model === selectedModel);
    }

    const last25 = logs.slice(-25);
    if (last25.length === 0) return;

    const maxTotal = Math.max(...last25.map(log => log.tokens.total));
    if (maxTotal === 0) return;

    const container = document.createElement("div");
    container.className = "chart-container";

    last25.forEach(log => {
        const bar = document.createElement("div");
        bar.className = "chart-bar";
        bar.style.height = ((log.tokens.total / maxTotal) * 100) + "%";
        bar.title = `${log.model}\n${log.tokens.total} tokens\n${log.tokens.cacheHit} hit\n${log.tokens.cacheMiss} miss\n${log.tokens.completion} completion`;

        const total = log.tokens.total || 1;

        const segments = [
            { cls: "bar-seg-cacheMiss", val: log.tokens.cacheMiss, color: modelNameToHsl(log.model, 70, 95) },
            { cls: "bar-seg-cacheHit",  val: log.tokens.cacheHit,  color: modelNameToHsl(log.model, 70, 60) },
            { cls: "bar-seg-completion", val: log.tokens.completion, color: modelNameToHsl(log.model, 55, 45) },
        ];

        segments.forEach(seg => {
            if (seg.val === 0) return;
            const div = document.createElement("div");
            div.className = "bar-seg " + seg.cls;
            div.style.height = ((seg.val / total) * 100) + "%";
            div.style.backgroundColor = seg.color;
            bar.appendChild(div);
        });

        container.appendChild(bar);
    });

    chart.appendChild(container);
}

const renderUIDebounced = debounce(renderUI, 150);
function renderUI() {
    updateLastGenerationStats();
    updateNonLastStatsOnPanel("session");
    updateNonLastStatsOnPanel("lifetime");
    updateSessionLogBarChart();
}

function modelNameToHsl(name, saturation = 70, lightness = 60) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function panelElemId(id) {
    return document.getElementById(EXT_PREFIX + id);
}
function panelElemText(id, content) {
    const elem = panelElemId(id);

    if (!elem) {
        log.warn(`Element not found: #ds-token--${id}`);
        return;
    }

    elem.textContent = content;
}
function populateModelSelector() {
    const modelSelector = panelElemId("modelSelector");
    const currentValue = modelSelector.value;

    modelSelector.innerHTML = "";

    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.innerHTML = "All models";
    modelSelector.append(allOption);

    Object.keys(deepseekCost).forEach(model => {
        const select = document.createElement("option");

        select.value = model;
        select.innerHTML = model;

        modelSelector.append(select);
    });

    modelSelector.value = deepseekCost[currentValue] ? currentValue : "all";
}
function modelDropdownChange() {
    renderUIDebounced();
}

const savePriceEditorDebounced = debounce(savePriceEditor, 300);
function savePriceEditor() {
    log("Saving price editor values.");

    const entries = panelElemId("priceEditorRows").querySelectorAll(".price-entry");
    const newCosts = {};

    entries.forEach(entry => {
        const modelName = entry.querySelector('[data-field="modelName"]').value.trim();
        const cached = parseFloat(entry.querySelector('[data-field="cached"]').value);
        const inCost = parseFloat(entry.querySelector('[data-field="in"]').value);
        const outCost = parseFloat(entry.querySelector('[data-field="out"]').value);

        if (!modelName) return;
        if (isNaN(cached) || isNaN(inCost) || isNaN(outCost)) return;

        newCosts[modelName] = {
            in: inCost,
            cached: cached,
            out: outCost,
        };
    });

    setDeepseekCost(newCosts);

    saveDeepSeekCostToLocalStorageDebounced();
    populateModelSelector();
    renderUIDebounced();
}
function populatePriceEditor() {
    const rowsContainer = panelElemId("priceEditorRows");
    rowsContainer.innerHTML = "";

    Object.keys(deepseekCost).forEach(modelName => {
        const modelCost = deepseekCost[modelName];
        rowsContainer.appendChild(createPriceRow(modelName, modelCost));
    });
}
function createPriceRow(modelName, cost) {
    const container = document.createElement("div");
    container.className = "price-entry";

    const modelRow = document.createElement("div");
    modelRow.className = "settings-editor-row";
    modelRow.appendChild(createPriceInput("text", "modelName", modelName));

    const costRow = document.createElement("div");
    costRow.className = "settings-editor-row";

    const priceFields = [
        { field: "cached", value: cost.cached, title: "Cached" },
        { field: "in", value: cost.in, title: "Input" },
        { field: "out", value: cost.out, title: "Output" },
    ];
    priceFields.forEach(item => {
        const input = createPriceInput("number", item.field, item.value);
        input.title = item.title;
        costRow.appendChild(input);
    });

    container.appendChild(modelRow);
    container.appendChild(costRow);

    return container;
}
function createPriceInput(type, field, value) {
    const input = document.createElement("input");
    input.type = type;
    input.step = "0.0001";
    input.dataset.field = field;
    input.value = value;
    input.className = "text_pole"; // ST built-in CSS

    return input;
}
function addModelRow() {
    const rowsContainer = panelElemId("priceEditorRows");
    const entry = createPriceRow("", DEFAULT_COST);

    rowsContainer.appendChild(entry);
    entry.querySelector("input").focus();
}

const savePeakTimeEditorDebounced = debounce(savePeakTimeEditor, 300);
function savePeakTimeEditor() {
    log("Saving peak time editor values.");

    const entries = panelElemId("peakTimeEditorRows").querySelectorAll(".peak-time-entry");
    const newTimes = [];

    entries.forEach(entry => {
        const start = entry.querySelector('[data-field="start"]').value;
        const end = entry.querySelector('[data-field="end"]').value;

        if (!start || !end) return;

        const weekdays = {};
        entry.querySelectorAll('[data-day]').forEach(button => {
            weekdays[button.dataset.day] = button.classList.contains("active");
        });

        newTimes.push({ start, end, weekdays });
    });

    setPeakTimes(newTimes);

    savePeakTimesToLocalStorageDebounced();
    updatePeakTimeIndicators();
    renderUIDebounced();
}
function populatePeakTimeEditor() {
    const rowsContainer = panelElemId("peakTimeEditorRows");
    rowsContainer.innerHTML = "";

    peakTimes.forEach(entry => {
        rowsContainer.appendChild(createPeakTimeEntry(entry.start, entry.end, entry.weekdays));
    });
}
function createPeakTimeEntry(start, end, weekdays) {
    const container = document.createElement("div");
    container.className = "peak-time-entry";

    const timesRow = document.createElement("div");
    timesRow.className = "settings-editor-row";
    timesRow.appendChild(createTimeInput(start, "start"));
    timesRow.appendChild(createTimeInput(end, "end"));

    const weekdayRow = document.createElement("div");
    weekdayRow.className = "settings-editor-row weekday-row";
    weekdayRow.title = "Peak applies only on the selected days (UTC)";

    const weekdayLabel = document.createElement("span");
    weekdayLabel.className = "weekday-label";
    weekdayLabel.textContent = "Days";
    weekdayRow.appendChild(weekdayLabel);

    PEAK_WEEKDAY_KEYS.forEach(day => {
        weekdayRow.appendChild(createWeekdayButton(day, weekdays[day]));
    });

    container.appendChild(timesRow);
    container.appendChild(weekdayRow);

    return container;
}
function createWeekdayButton(day, active) {
    const label = day[0].toUpperCase() + day.slice(1);

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.day = day;
    button.className = "weekday-btn menu_button" + (active ? " active" : "");
    button.textContent = label;

    return button;
}
function createTimeInput(value, field) {
    const input = document.createElement("input");
    input.type = "time";
    // 1:00 does not work, it ABSOLUTELY needs 01:00
    // ternary for the case of new row.
    input.value = value ? value.padStart(5, "0") : "";
    input.dataset.field = field;
    input.className = "text_pole";

    return input;
}
function addTimeRow() {
    const rowsContainer = panelElemId("peakTimeEditorRows");
    const entry = createPeakTimeEntry("", "", DEFAULT_PEAK_WEEKDAYS);
    rowsContainer.appendChild(entry);
    entry.querySelector("input").focus();
}
function onPeakTimeEditorClick(event) {
    const button = event.target.closest('[data-day]');
    if (button) {
        button.classList.toggle("active");
    }

    savePeakTimeEditorDebounced();
}
function updatePeakTimeIndicators() {
    const activePeakHours = getActivatedPeakHours();

    showPeakTimeInTitleBadge(activePeakHours);
    showCurrentUTCTime(activePeakHours);
}
function showPeakTimeInTitleBadge(activePeakHours) {
    const icon = panelElemId("header-badge");

    icon.style.color = activePeakHours.length ? "orange" : "green";
}
function showCurrentUTCTime(activePeakHours) {
    const currentTime = new Date();
    const hour = currentTime.getUTCHours().toString().padStart(2, "0");
    const minute = currentTime.getUTCMinutes().toString().padStart(2, "0");
    const formattedTime = `${hour}:${minute}`;

    let msg;

    if (activePeakHours.length) {
        const firstPeakHours = activePeakHours[0];
        let timeLeft = timeToInt(firstPeakHours.end) - timeToInt(formattedTime);
        if (timeLeft < 0) timeLeft += 1440; // 24h * 60m

        msg = `[ ${formattedTime} ] On peak hours! ${timeLeft} minute${ timeLeft == 1 ? "" : "s" } left.`;
    } else {
        msg = `[ ${formattedTime} ] Click to refresh time.`;
    }

    panelElemId("timeInUtcBtn").innerHTML = msg;
}
function timeToInt(time) {
    const splitTime = time.split(":");
    const hour = parseInt(splitTime[0]);
    const minute = parseInt(splitTime[1]);

    return (hour * 60) + minute;
}
function isTimeTargetBetween(start, end, value) {
    if (start > end) {
        return start <= value || end >= value;
    } else {
        return start <= value && end >= value;
    }
}
function getActivatedPeakHours() {
    const currentTime = new Date();
    const hour = currentTime.getUTCHours();
    const minute = currentTime.getUTCMinutes();
    const currentTimeUTC = timeToInt(`${hour}:${minute}`);
    const today = PEAK_WEEKDAY_KEYS[currentTime.getUTCDay()];

    return peakTimes.filter(entry => {
        if (!entry.weekdays[today]) return false;

        const start = timeToInt(entry.start);
        const end = timeToInt(entry.end);
        return isTimeTargetBetween(start, end, currentTimeUTC);
    });
}

function showLastOnMessage({ modelName, tokens, ratio }) {
    const statBlockElemId = EXT_PREFIX + "last_gen_stat";

    const chatContainer = document.getElementById('chat');
    const lastChatElem = chatContainer.lastChild;
    let statBlock = document.getElementById(statBlockElemId);

    if (!statBlock) {
        log.warn("No statBlock element found in #chat.");
        const newStatBlock = document.createElement("div");
        newStatBlock.id = statBlockElemId;
        chatContainer.appendChild(newStatBlock);
        statBlock = newStatBlock;
    }

    if (lastChatElem && lastChatElem.id !== statBlock.id) {
        log("Moving statBlock to bottom.")
        statBlock.parentNode.appendChild(statBlock);
    }

    const inTokens = numberComma(tokens.prompt);
    const outTokens = numberComma(tokens.completion);

    statBlock.textContent = `${modelName}: ${inTokens} → ${outTokens} (${ratio.toFixed(1)}%)`;
}

jQuery(async () => {
    overrideFetch();

    setDeepseekCost(fetchDeepSeekCostFromLocalStorage())
    setPeakTimes(fetchPeakTimesFromLocalStorage());

    Object.keys(deepseekCost).forEach(modelName => {
        accumulatedUsage.models[modelName] = structuredClone(Usage);
    });

    setLifetimeUsage(fetchLifetimeUsageFromLocalStorage());
    setSessionUsage(structuredClone(accumulatedUsage));

    let panelHtml = await $.get(`${EXTENSION_FOLDER_PATH}/panel.html`);
    panelHtml = panelHtml.replaceAll('id="', `id="${EXT_PREFIX}`);
    $("#extensions_settings2").append(panelHtml);

    updateNonLastStatsOnPanel("lifetime");

    populateModelSelector();
    panelElemId("modelSelector").addEventListener("change", modelDropdownChange);

    populatePriceEditor();
    panelElemId("priceEditorRows").addEventListener("input", savePriceEditorDebounced);
    panelElemId("addModelBtn").addEventListener("click", addModelRow);

    populatePeakTimeEditor();
    panelElemId("peakTimeEditorRows").addEventListener("input", savePeakTimeEditorDebounced);
    panelElemId("peakTimeEditorRows").addEventListener("click", onPeakTimeEditorClick);
    panelElemId("timeInUtcBtn").addEventListener("click", showCurrentUTCTime);
    panelElemId("addPeakTimeBtn").addEventListener("click", addTimeRow);
    updatePeakTimeIndicators();
    setInterval(updatePeakTimeIndicators, 30000);

    log("Extension loaded!");
});
