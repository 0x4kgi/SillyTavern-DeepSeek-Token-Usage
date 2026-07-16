const EXTENSION_NAME = "SillyTavern-DeepSeek-Token-Usage";
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

const PANEL_PREFIX = "ds-token--";

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

// Ephemeral tracking
// Will reset at page refresh. INTENTIONAL.
let sessionUsage = {
    prompt: 0,
    cacheHit: 0,
    cacheMiss: 0,
    completion: 0,
    reasoning: 0,
    response: 0,
    total: 0,

    promptCost: 0.0,
    cacheHitCost: 0.0,
    cacheMissCost: 0.0,
    completionCost: 0.0,
    reasoningCost: 0.0,
    responseCost: 0.0,
    totalCost: 0.0,

    ratio: 0.0,
    requestCount: 0,
};

/** @type {sessionUsage} */
let lifetimeUsage;

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

    const raw = localStorage.getItem("lifetimeUsage");

    if (!raw) {
        log.warn("No lifetime stats saved.")
        return structuredClone(sessionUsage);
    }

    return JSON.parse(raw);
}

function saveLifetimeUsageToLocalStorage() {
    log("Saving lifetimeUsage.");
    localStorage.setItem("lifetimeUsage", JSON.stringify(lifetimeUsage));
}

// Is this a bad idea?
// Who knows.
// It works.
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
    obj.ratio = obj.prompt > 0 ? (obj.cacheHit / obj.prompt) * 100 : 0;

    return obj;
}

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
 * @param {ReturnType<typeof parseUsageObject>} tokens
 * @param {ReturnType<typeof calculateTokenCost>} cost
 */
function saveSessionUsage(tokens, cost) {
    sessionUsage.prompt += tokens.prompt;
    sessionUsage.cacheHit += tokens.cacheHit;
    sessionUsage.cacheMiss += tokens.cacheMiss;
    sessionUsage.completion += tokens.completion;
    sessionUsage.reasoning += tokens.reasoning;
    sessionUsage.response += tokens.response;
    sessionUsage.total += tokens.total;

    sessionUsage.promptCost += cost.prompt;
    sessionUsage.cacheHitCost += cost.cacheHit;
    sessionUsage.cacheMissCost += cost.cacheMiss;
    sessionUsage.completionCost += cost.completion;
    sessionUsage.reasoningCost += cost.reasoning;
    sessionUsage.responseCost += cost.response;
    sessionUsage.totalCost += cost.total;

    sessionUsage.ratio = sessionUsage.prompt > 0 ?
        (sessionUsage.cacheHit / sessionUsage.prompt) * 100
        : 0;
    sessionUsage.requestCount += 1;
}

/**
 * @param {ReturnType<typeof parseUsageObject>} tokens
 * @param {ReturnType<typeof calculateTokenCost>} cost
 */
// TODO: code repetitiion. Look above.
function incrementLifetimeUsage(tokens, cost) {
    lifetimeUsage.prompt += tokens.prompt;
    lifetimeUsage.cacheHit += tokens.cacheHit;
    lifetimeUsage.cacheMiss += tokens.cacheMiss;
    lifetimeUsage.completion += tokens.completion;
    lifetimeUsage.reasoning += tokens.reasoning;
    lifetimeUsage.response += tokens.response;
    lifetimeUsage.total += tokens.total;

    lifetimeUsage.promptCost += cost.prompt;
    lifetimeUsage.cacheHitCost += cost.cacheHit;
    lifetimeUsage.cacheMissCost += cost.cacheMiss;
    lifetimeUsage.completionCost += cost.completion;
    lifetimeUsage.reasoningCost += cost.reasoning;
    lifetimeUsage.responseCost += cost.response;
    lifetimeUsage.totalCost += cost.total;

    lifetimeUsage.ratio = lifetimeUsage.prompt > 0 ?
        (lifetimeUsage.cacheHit / lifetimeUsage.prompt) * 100
        : 0;
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

// God, this fucntion looks so ass :sob:
function processUsageData(usage) {
    if (!usage) return;

    log("Processing Usage data for display.");
    const tokens = parseUsageObject(usage);
    const tokenCost = calculateTokenCost(tokens);
    saveSessionUsage(tokens, tokenCost);
    incrementLifetimeUsage(tokens, tokenCost);
    saveLifetimeUsageToLocalStorage();

    // Last Message
    panelElemText('prompt', tokens.prompt);
    panelElemText('completion', tokens.completion);
    panelElemText('total', tokens.total);
    panelElemText('totalCost', tokenCost.total.toFixed(5));

    panelElemText('reasoning', tokens.reasoning);
    panelElemText('response', tokens.response);

    panelElemText('cacheHit', tokens.cacheHit);
    panelElemText('cacheMiss', tokens.cacheMiss);
    panelElemId('ratio').value = tokens.ratio;
    panelElemText('model', modelName);

    updateNonLastStatsOnPanel("session");
    updateNonLastStatsOnPanel("lifetime");
}

function updateNonLastStatsOnPanel(statType = "session") {

    /** @type {sessionUsage} */
    let stat;

    if (statType === "session") {
        stat = sessionUsage;
    } else if (statType === "lifetime") {
        stat = lifetimeUsage;
    } else {
        log.warn("Not valid statType:", statType);
        return;
    }

    panelElemText(`${statType}_prompt`, stat.prompt);
    panelElemText(`${statType}_completion`, stat.completion);
    panelElemText(`${statType}_total`, stat.total);
    panelElemText(`${statType}_totalCost`, `${stat.totalCost.toFixed(5)}`);

    panelElemText(`${statType}_reasoning`, stat.reasoning);
    panelElemText(`${statType}_response`, stat.response);

    panelElemText(`${statType}_cacheHit`, stat.cacheHit);
    panelElemText(`${statType}_cacheMiss`, stat.cacheMiss);
    panelElemId(`${statType}_ratio`).value = stat.ratio;
    panelElemText(`${statType}_requestCount`, stat.requestCount);
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

jQuery(async () => {
    overrideFetch();

    lifetimeUsage = fetchLifetimeUsageFromLocalStorage();

    let panelHtml = await $.get(`${EXTENSION_FOLDER_PATH}/panel.html`);
    panelHtml = panelHtml.replaceAll('id="', `id="${PANEL_PREFIX}`);
    $("#extensions_settings2").append(panelHtml);

    updateNonLastStatsOnPanel("lifetime");

    populateModelSelector();

    log("Extension loaded!");
});
