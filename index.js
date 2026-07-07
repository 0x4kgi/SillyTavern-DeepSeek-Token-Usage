const extensionName = "SillyTavern-DeepSeek-Token-Usage";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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
    // depreciated models.
    // remove after july 27?
    "deepseek-chat": {
        in: 0.14,
        cached: 0.0028,
        out: 0.28,
    },
    "deepseek-reasoner": {
        in: 0.14,
        cached: 0.0028,
        out: 0.28,
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

    promptCost: 0.0,
    cacheHitCost: 0.0,
    cacheMissCost: 0.0,
    completionCost: 0.0,

    ratio: 0.0,
};

function log(...args) {
    console.log(`[${extensionName}]`, ...args);
}

// Is this a bad idea?
// Who knows.
// It works.
function overrideFetch() {
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
            const clonedResponse = response.clone();

            const requestJson = JSON.parse(requestBody?.body);
            modelName = requestJson.model || null;
            completionSource = requestJson.chat_completion_source || null;

            // since this is only useful for deepseek for now...
            if (completionSource === "deepseek") {
                handleStream(clonedResponse.body);
            }

            return response;
        } catch (error) {
            console.error("Error intercepting fetch:", error);
        }
    };
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
        console.error("Error reading stream:", err);
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
    };
    obj.prompt = obj.cacheHit + obj.cacheMiss;

    return obj;
}

function saveSessionUsage(tokens, cost) {
    sessionUsage.prompt += tokens.prompt;
    sessionUsage.cacheHit += tokens.cacheHit;
    sessionUsage.cacheMiss += tokens.cacheMiss;
    sessionUsage.completion += tokens.completion;
    sessionUsage.reasoning += tokens.reasoning;
    sessionUsage.response += tokens.response;

    sessionUsage.promptCost += cost.prompt;
    sessionUsage.cacheHitCost += cost.cacheHit;
    sessionUsage.cacheMissCost += cost.cacheMiss;
    sessionUsage.completionCost += cost.completion;

    sessionUsage.ratio = sessionUsage.prompt > 0 ?
        (sessionUsage.cacheHit / sessionUsage.prompt) * 100
        : 0;
}

function panelElemId(id) {
    return document.getElementById("ds-token--" + id);
}

// God, this fucntion looks so ass :sob:
function processUsageData(usage) {
    if (!usage) return;

    const tokens = parseUsageObject(usage);
    const tokenCost = calculateTokenCost(tokens);
    saveSessionUsage(tokens, tokenCost);

    // Last Message
    panelElemId('prompt_tokens').textContent = tokens.prompt;
    panelElemId('completion_tokens').textContent = tokens.completion;
    panelElemId('total_tokens').textContent = tokens.total;

    panelElemId('reasoning_tokens').textContent = tokens.reasoning;
    panelElemId('response_tokens').textContent = tokens.response;

    panelElemId('prompt_cache_hit_tokens').textContent = tokens.cacheHit;
    panelElemId('prompt_cache_miss_tokens').textContent = tokens.cacheMiss;
    panelElemId('cache_ratio').textContent = `${tokens.ratio.toFixed(1)}%`;

    // Session
    panelElemId('session_prompt_tokens').textContent = sessionUsage.prompt;
    panelElemId('session_completion_tokens').textContent = sessionUsage.completion;
    panelElemId('session_total_tokens').textContent = sessionUsage.prompt + sessionUsage.completion;

    const sessionTotalCost = sessionUsage.promptCost + sessionUsage.completionCost;
    panelElemId('session_prompt_cost').textContent = `${sessionUsage.promptCost.toFixed(5)}`;
    panelElemId('session_completion_cost').textContent = `${sessionUsage.completionCost.toFixed(5)}`;
    panelElemId('session_total_cost').textContent = `${sessionTotalCost.toFixed(5)}`;

    panelElemId('session_reasoning_tokens').textContent = sessionUsage.reasoning;
    panelElemId('session_response_tokens').textContent = sessionUsage.response;

    panelElemId('session_prompt_cache_hit_tokens').textContent = sessionUsage.cacheHit;
    panelElemId('session_prompt_cache_miss_tokens').textContent = sessionUsage.cacheMiss;
    panelElemId('session_cache_ratio').textContent = `${sessionUsage.ratio.toFixed(1)}%`;
}

jQuery(async () => {
    log("Loaded.");

    const panelHtml = await $.get(`${extensionFolderPath}/panel.html`);
    $("#extensions_settings2").append(panelHtml);

    overrideFetch();
});
