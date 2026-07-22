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
const DEFAULT_COST = {
    in: 0.0,
    cached: 0.0,
    out: 0.0,
};

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


// Hard coded for now.
// What are these names
function fetchLifetimeUsageFromLocalStorage() {
    log("Fetching localStorage for saved stats.");

    const raw = localStorage.getItem(`${EXT_PREFIX}lifetimeUsage`);
    let data;

    if (!raw) {
        log.warn("No lifetime stats saved.")
        data = structuredClone(accumulatedUsage);
    } else {
        data = JSON.parse(raw);
    }

    for (const modelName in DEEPSEEK_COST) {
        if (!data.models[modelName]) {
            data.models[modelName] = structuredClone(Usage);
        }
    }

    return data;
}
function saveLifetimeUsageToLocalStorage() {
    log("Saving lifetimeUsage.");

    let _lifetimeUsage = structuredClone(lifetimeUsage);

    log("What to save: ", _lifetimeUsage);

    localStorage.setItem(`${EXT_PREFIX}lifetimeUsage`, JSON.stringify(_lifetimeUsage));
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
function handleStreamLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;

    const jsonString = trimmed.replace(/^data:\s*/, "");
    if (jsonString === "[DONE]" || !jsonString) return;

    try {
        const parsed = JSON.parse(jsonString);
        if (parsed && parsed.usage) {
            log("Found Usage Data:", parsed.model, parsed.usage);
            processUsageData(parsed.usage, parsed.model);
        }
    } catch (_) { }
}
async function handleNonStream(data) {
    if (!data) return;

    if (data.usage) {
        log("Found Usage Data:", data.model, data.usage);
        processUsageData(data.usage, data.model);
    } else {
        log.warn("Response does not include usage data.")
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
    }
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
    const tokenPrice = DEEPSEEK_COST[modelName];

    if (!tokenPrice) {
        return DEFAULT_COST;
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
 * @param {Statistic} model
 */
function saveAggregatedUsage(usageLog, tokens, model) {
    let modelObject = usageLog.models[model] || structuredClone(Usage);

    modelObject.model = model;
    modelObject.timestamp = Date.now();
    modelObject.count += 1;

    Object.keys(tokens).forEach(parameter => {
        modelObject.tokens[parameter] += tokens[parameter];
    });

    usageLog.requestCount += 1;
    usageLog.models[model] = modelObject;
}

function processUsageData(usage, model) {
    if (!usage) return;

    log("Processing Usage data for display.");
    const tokens = parseUsageObject(usage);
    saveAggregatedUsage(sessionUsage, tokens, model);
    saveAggregatedUsage(lifetimeUsage, tokens, model);

    sessionLog.push({
        model: model,
        timestamp: Date.now(),
        count: 1,
        tokens: { ...tokens },
    });

    saveLifetimeUsageToLocalStorage();

    updateLastGenerationStats();

    updateNonLastStatsOnPanel("session");
    updateNonLastStatsOnPanel("lifetime");
}

/**
 *
 * @param {accumulatedUsage} source
 * @returns {Usage}
 */
function getAllModelStats(source) {
    let accumulated = structuredClone(Usage);

    Object.keys(source.models).forEach(modelName => {
        const modelStats = source.models[modelName];
        Object.keys(modelStats.tokens).forEach(param => {
            accumulated.tokens[param] += modelStats.tokens[param];
        });

        const tokenCost = calculateTokenCost(modelStats.tokens, modelName);
        accumulated.cost ??= structuredClone(Statistic);

        Object.keys(tokenCost).forEach(param => {
            accumulated.cost[param] += tokenCost[param];
        });
    });

    return accumulated;
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
    tokenCost = lastLog ? calculateTokenCost(tokens, modelName) : structuredClone(Statistic);

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
        sourceStat = sessionUsage;
    } else if (statType === "lifetime") {
        sourceStat = lifetimeUsage;
    } else {
        log.warn("Not valid statType:", statType);
        return;
    }

    requestCount = sourceStat.requestCount;

    if (selectedModel === "all") {
        stat = getAllModelStats(sourceStat);
        // stat.cost is handled by the function above
    } else {
        stat = sourceStat.models[selectedModel];
        stat.cost = calculateTokenCost(stat.tokens, selectedModel);
        requestCount = stat.count; // override when specific model, ig.
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
    updateNonLastStatsOnPanel("lifetime");
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

    Object.keys(DEEPSEEK_COST).forEach(modelName => {
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

    log("Extension loaded!");
});
