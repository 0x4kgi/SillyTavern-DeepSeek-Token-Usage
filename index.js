const EXTENSION_NAME = "SillyTavern-DeepSeek-Token-Usage";
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;
const EXT_PREFIX = "ds-token--";

// Default prices, as fallback
// Need to update this when DS's price updates
// https://api-docs.deepseek.com/quick_start/pricing
const DEFAULT_DEEPSEEK_COST = {
    "deepseek-v4-flash": {
        in: 0.14,
        cached: 0.0028,
        out: 0.28,
    },
    "deepseek-v4-pro": {
        in: 0.435,
        cached: 0.003625,
        out: 0.87,
    },
};
const DEFAULT_COST = {
    in: 0.0,
    cached: 0.0,
    out: 0.0,
};
const DEFAULT_PEAK_TIMES = [
    // UTC times
    ["01:00", "04:00"],
    ["06:00", "10:00"],
];

/** @type {Object<string, DEFAULT_COST>} */
let deepseekCost = {};
let peakTimes = [];

const Statistic = {
    prompt: 0,
    cacheHit: 0,
    cacheMiss: 0,
    completion: 0,
    reasoning: 0,
    response: 0,
    total: 0,
};
const Usage = {
    model: '',
    timestamp: 0,
    count: 0,
    tokens: structuredClone(Statistic),
    extra: structuredClone(Statistic),
};

let accumulatedUsage = {
    requestCount: 0,

    /** @type {Object<string, Usage>} */
    models: {}
};

/** @type {accumulatedUsage} */
let lifetimeUsage;

/** @type {accumulatedUsage} */
let sessionUsage;

/** @type {Usage[]} */
let sessionLog = [];

function log(...args) {
    console.log(`[${EXTENSION_NAME}]`, ...args);
}
["warn", "error"].forEach(item => {
    log[item] = function (...args) {
        console[item](`[${EXTENSION_NAME}]`, ...args);
    }
});

function debounce(func, timeout = 300){
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

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

    data = data.filter(isValidPeakTime);

    return data;
}
function isValidPeakTime(times) {
    if (!Array.isArray(times) || times.length < 2) return false;

    const [start, end] = times;
    if (typeof start !== "string" || typeof end !== "string") return false;

    return !Number.isNaN(timeToInt(start)) && !Number.isNaN(timeToInt(end));
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
    panelElemText('prompt', tokens.prompt);
    panelElemText('completion', tokens.completion);
    panelElemText('total', tokens.total);
    panelElemText('totalCost', displayTotalCost.toFixed(5));

    panelElemText('reasoning', tokens.reasoning);
    panelElemText('response', tokens.response);

    panelElemText('cacheHit', tokens.cacheHit);
    panelElemText('cacheMiss', tokens.cacheMiss);
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

    panelElemText(`${statType}_prompt`, stat.tokens.prompt);
    panelElemText(`${statType}_completion`, stat.tokens.completion);
    panelElemText(`${statType}_total`, stat.tokens.total);
    panelElemText(`${statType}_totalCost`, `${totalCost.toFixed(5)}`);

    panelElemText(`${statType}_reasoning`, stat.tokens.reasoning);
    panelElemText(`${statType}_response`, stat.tokens.response);

    panelElemText(`${statType}_cacheHit`, stat.tokens.cacheHit);
    panelElemText(`${statType}_cacheMiss`, stat.tokens.cacheMiss);

    panelElemId(`${statType}_ratio`).value = ratio;
    panelElemText(`${statType}_requestCount`, requestCount);
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

    const rows = panelElemId("priceEditorRows").querySelectorAll(".settings-editor-row");
    const newCosts = {};

    rows.forEach(row => {
        const modelName = row.querySelector('[data-field="modelName"]').value.trim();
        const cached = parseFloat(row.querySelector('[data-field="cached"]').value);
        const inCost = parseFloat(row.querySelector('[data-field="in"]').value);
        const outCost = parseFloat(row.querySelector('[data-field="out"]').value);

        if (!modelName) return;
        if (isNaN(cached) || isNaN(inCost) || isNaN(outCost)) return;

        newCosts[modelName] = {
            in: inCost,
            cached: cached,
            out: outCost,
        };
    });

    deepseekCost = newCosts;

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
    const row = document.createElement("div");
    row.className = "settings-editor-row";

    row.appendChild(createPriceInput("text", "modelName", modelName));
    row.appendChild(createPriceInput("number", "cached", cost.cached));
    row.appendChild(createPriceInput("number", "in", cost.in));
    row.appendChild(createPriceInput("number", "out", cost.out));

    return row;
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
    const row = createPriceRow("", DEFAULT_COST);

    rowsContainer.appendChild(row);
    row.querySelector("input").focus();
}

const savePeakTimeEditorDebounced = debounce(savePeakTimeEditor, 300);
function savePeakTimeEditor() {
    log("Saving peak time editor values.");

    const rows = panelElemId("peakTimeEditorRows").querySelectorAll(".settings-editor-row");
    const newTimes = [];

    rows.forEach(row => {
        const start = row.querySelector('[data-field="start"]').value;
        const end = row.querySelector('[data-field="end"]').value;

        if (!start || !end) return;

        newTimes.push([start, end]);
    });

    peakTimes = newTimes;

    savePeakTimesToLocalStorageDebounced();
    showCurrentUTCTime();
    renderUIDebounced();
}
function populatePeakTimeEditor() {
    const rowsContainer = panelElemId("peakTimeEditorRows");
    rowsContainer.innerHTML = "";

    peakTimes.forEach(times => {
        const start = times[0];
        const end = times[1];
        rowsContainer.appendChild(createTimesRow(start, end));
    });
}
function createTimesRow(start, end) {
    const row = document.createElement("div");
    row.className = "settings-editor-row";
    row.appendChild(createTimeInput(start, "start"));
    row.appendChild(createTimeInput(end, "end"));

    return row;
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
    const row = createTimesRow("", "");
    rowsContainer.appendChild(row);
    row.querySelector("input").focus();
}
function showCurrentUTCTime() {
    const currentTime = new Date();
    const hour = currentTime.getUTCHours().toString().padStart(2, "0");
    const minute = currentTime.getUTCMinutes().toString().padStart(2, "0");
    const formattedTime = `${hour}:${minute}`;
    const activePeakHours = getActivatedPeakHours();

    let msg;

    if (activePeakHours.length) {
        const firstPeakHours = activePeakHours[0];
        const timeLeft = timeToInt(firstPeakHours[1]) - timeToInt(formattedTime);
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

    return peakTimes.filter(times => {
        const start = timeToInt(times[0]);
        const end = timeToInt(times[1]);
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

    statBlock.textContent = `${modelName}: ${tokens.prompt} → ${tokens.completion} (${ratio.toFixed(1)}%)`;
}

jQuery(async () => {
    overrideFetch();

    deepseekCost = fetchDeepSeekCostFromLocalStorage();
    peakTimes = fetchPeakTimesFromLocalStorage();

    Object.keys(deepseekCost).forEach(modelName => {
        accumulatedUsage.models[modelName] = structuredClone(Usage);
    });

    lifetimeUsage = fetchLifetimeUsageFromLocalStorage();
    sessionUsage = structuredClone(accumulatedUsage);

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
    panelElemId("timeInUtcBtn").addEventListener("click", showCurrentUTCTime);
    panelElemId("addPeakTimeBtn").addEventListener("click", addTimeRow);
    showCurrentUTCTime();
    setInterval(showCurrentUTCTime, 30000);

    log("Extension loaded!");
});
