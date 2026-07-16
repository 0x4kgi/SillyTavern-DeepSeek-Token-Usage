const EXTENSION_NAME = "SillyTavern-DeepSeek-Token-Usage";
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

const EXT_PREFIX = "ds-token--";

// Should be editable.
// But since this ext is for personal use...
// eh.
const DEEPSEEK_COST = {
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

// Might be useful in the future, so we are storing it "globally"
// Will change everytime a gen occurs.
// Not sure what to feel about it, for now.
let modelName;
let completionSource;

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
    tokens: structuredClone(Statistic),
    cost: structuredClone(Statistic),
};

/** @type {Usage} */
let lifetimeUsage;

/** @type {Usage} */
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


// Hard coded for now.
// What are these names
function fetchLifetimeUsageFromLocalStorage() {
    log("Fetching localStorage for saved stats.");

    const raw = localStorage.getItem(`${EXT_PREFIX}lifetimeUsage`);
    let data;

    if (!raw) {
        log.warn("No lifetime stats saved.")
        data = structuredClone(Usage);
    } else {
        data = JSON.parse(raw);
    }

    // add some needed values to prevent NaN-ing
    data.requestCount ??= 0;

    return data;
}

function saveLifetimeUsageToLocalStorage() {
    log("Saving lifetimeUsage.");
    localStorage.setItem(`${EXT_PREFIX}lifetimeUsage`, JSON.stringify(lifetimeUsage));
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

        try {
            const response = await originalFetch.apply(this, args);
            handleResponse(response, requestBody)
            return response;
        } catch (error) {
            log.error("Error intercepting fetch:", error);
        }
    };
}

async function handleResponse(response, requestBody) {
    const clonedResponse = response.clone();

    const requestJson = JSON.parse(requestBody?.body);
    modelName = requestJson.model ?? null;
    completionSource = requestJson.chat_completion_source ?? null;

    const responseType = response.headers.get("Content-Type") ?? "";
    const isStreaming = !responseType.includes("application/json")

    // since this is only useful for deepseek for now...
    if (completionSource !== "deepseek") return;

    if (isStreaming) {
        log("Response is streaming!")
        handleStream(clonedResponse.body);
    } else {
        log("Response in non-streaming!");
        const responseJson = await clonedResponse.json();
        handleNonStream(responseJson);
    }
}

async function handleStream(stream) {
    if (!stream) return;

    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop();

            for (const line of lines) {
                handleStreamLine(line);
            }
        }
    } catch (err) {
        log.error("Error reading stream:", err);
    }
}

async function handleNonStream(data) {
    if (!data) return;

    if (data.usage) {
        log("Found Usage Data:", data.usage);
        processUsageData(data.usage);
    } else {
        log.warn("Response does not include usage data.")
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
            log("Found Usage Data:", parsed.usage);
            processUsageData(parsed.usage);
        }
    } catch (_) { }
}

/**
 *
 * @param {any} usage
 * @returns {Statistic}
 */
function parseUsageObject(usage) {
    const obj = {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
        response: 0,
        cacheHit: usage.prompt_cache_hit_tokens || 0,
        cacheMiss: usage.prompt_cache_miss_tokens || 0,
        ratio: 0,
    }
    obj.response = obj.completion - obj.reasoning;

    return obj;
}

/**
 *
 * @param {Statistic} tokens
 * @returns {Statistic}
 */
function calculateTokenCost(tokens) {
    const tokenPrice = DEEPSEEK_COST[modelName];
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
 * @param {Statistic} tokens
 * @param {Statistic} cost
 */
function saveSessionUsage(tokens, cost) {
    sessionUsage.model = modelName;

    Object.keys(tokens).forEach(parameter => {
        sessionUsage.tokens[parameter] += tokens[parameter];
    });

    Object.keys(cost).forEach(parameter => {
        sessionUsage.cost[parameter] += cost[parameter];
    });

    sessionLog.push({
        model: modelName,
        tokens: { ...tokens },
        cost: { ...cost }
    });
}

/**
 * @param {Statistic} tokens
 * @param {Statistic} cost
 */
// TODO: code repetitiion. Look above.
function incrementLifetimeUsage(tokens, cost) {
    lifetimeUsage.model = modelName;

    Object.keys(tokens).forEach(parameter => {
        lifetimeUsage.tokens[parameter] += tokens[parameter];
    });

    Object.keys(cost).forEach(parameter => {
        lifetimeUsage.cost[parameter] += cost[parameter];
    });

    lifetimeUsage.requestCount += 1;
}

function panelElemId(id) {
    return document.getElementById("ds-token--" + id);
}

function panelElemText(id, content) {
    const elem = panelElemId(id);

    if (!elem) {
        log.warn(`Element not found: #ds-token--${id}`);
        return;
    }

    elem.textContent = content;
}

function processUsageData(usage) {
    if (!usage) return;

    log("Processing Usage data for display.");
    const tokens = parseUsageObject(usage);
    const tokenCost = calculateTokenCost(tokens);
    saveSessionUsage(tokens, tokenCost);
    incrementLifetimeUsage(tokens, tokenCost);
    saveLifetimeUsageToLocalStorage();

    updateLastGenerationStats();

    updateNonLastStatsOnPanel("session");
    updateNonLastStatsOnPanel("lifetime");
}

/**
 *
 * @param {string} model
 * @returns {Usage}
 */
function collectStatsForModel(model) {
    let count = 0;
    let modelData = sessionLog.filter(usageLog => usageLog.model === model)
        .reduce((acc, curr) => {
            // oh god what am i doing
            Object.keys(curr.tokens).forEach(param => {
                acc.tokens[param] += curr.tokens[param];
            });

            Object.keys(curr.cost).forEach(param => {
                acc.cost[param] += curr.cost[param];
            });

            count += 1;

            return acc;
        }, structuredClone(Usage));
    modelData.model = model;
    modelData.count = count;

    return modelData;
}

function updateLastGenerationStats() {
    const selectedModel = panelElemId("modelSelector").value;

    let tokens;
    let tokenCost;
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
    tokenCost = lastLog ? lastLog.cost : structuredClone(Statistic);

    const ratio = tokens.prompt > 0 ?
        (tokens.cacheHit / tokens.prompt) * 100
        : 0;

    // Last Message
    panelElemText('prompt', tokens.prompt);
    panelElemText('completion', tokens.completion);
    panelElemText('total', tokens.total);
    panelElemText('totalCost', tokenCost.total.toFixed(5));

    panelElemText('reasoning', tokens.reasoning);
    panelElemText('response', tokens.response);

    panelElemText('cacheHit', tokens.cacheHit);
    panelElemText('cacheMiss', tokens.cacheMiss);
    panelElemId('ratio').value = ratio;
    panelElemText('model', modelName);
}

function updateNonLastStatsOnPanel(statType = "session") {
    /** @type {Usage} */
    let stat;
    let requestCount;

    const selectedModel = panelElemId("modelSelector").value;

    if (statType === "session") {
        if (selectedModel === "all") {
            stat = sessionUsage;
            requestCount = sessionLog.length;
        } else {
            stat = collectStatsForModel(selectedModel);
            requestCount = stat.count;
        }
    } else if (statType === "lifetime") {
        stat = lifetimeUsage;
        requestCount = lifetimeUsage.requestCount;
    } else {
        log.warn("Not valid statType:", statType);
        return;
    }

    const ratio = stat.tokens.prompt > 0 ?
        (stat.tokens.cacheHit / stat.tokens.prompt) * 100
        : 0;

    panelElemText(`${statType}_prompt`, stat.tokens.prompt);
    panelElemText(`${statType}_completion`, stat.tokens.completion);
    panelElemText(`${statType}_total`, stat.tokens.total);
    panelElemText(`${statType}_totalCost`, `${stat.cost.total.toFixed(5)}`);

    panelElemText(`${statType}_reasoning`, stat.tokens.reasoning);
    panelElemText(`${statType}_response`, stat.tokens.response);

    panelElemText(`${statType}_cacheHit`, stat.tokens.cacheHit);
    panelElemText(`${statType}_cacheMiss`, stat.tokens.cacheMiss);

    panelElemId(`${statType}_ratio`).value = ratio;
    panelElemText(`${statType}_requestCount`, requestCount);
}

function populateModelSelector() {
    const modelSelector = panelElemId("modelSelector");

    Object.keys(DEEPSEEK_COST).forEach(model => {
        const select = document.createElement("option");

        select.value = model;
        select.innerHTML = model;

        modelSelector.append(select);
    });
}

function modelDropdownChange() {
    const selectedModel = panelElemId("modelSelector").value;
    updateLastGenerationStats();
    updateNonLastStatsOnPanel("session");
}

jQuery(async () => {
    overrideFetch();

    lifetimeUsage = fetchLifetimeUsageFromLocalStorage();

    sessionUsage = structuredClone(Usage);

    let panelHtml = await $.get(`${EXTENSION_FOLDER_PATH}/panel.html`);
    panelHtml = panelHtml.replaceAll('id="', `id="${EXT_PREFIX}`);
    $("#extensions_settings2").append(panelHtml);

    updateNonLastStatsOnPanel("lifetime");

    populateModelSelector();

    panelElemId("modelSelector").addEventListener("change", modelDropdownChange);

    log("Extension loaded!");
});
