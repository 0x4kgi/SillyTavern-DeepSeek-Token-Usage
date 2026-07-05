const extensionName = "SillyTavern-DeepSeek-Token-Usage";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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
        if (typeof url === 'string' && url.includes('/api/backends/chat-completions/generate')) {
            try {
                const response = await originalFetch.apply(this, args);
                const clonedResponse = response.clone();
                handleStream(clonedResponse.body);
                return response;
            } catch (error) {
                console.error("Error intercepting fetch:", error);
            }
        }
        return originalFetch.apply(this, args);
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
                const trimmed = line.trim();
                if (trimmed.startsWith("data:")) {
                    const jsonString = trimmed.replace(/^data:\s*/, "");

                    if (jsonString === "[DONE]" || !jsonString) continue;
                    try {
                        const parsed = JSON.parse(jsonString);
                        if (parsed && parsed.usage) {
                            log("Found Usage Data:", parsed.usage);
                            processUsageData(parsed.usage);
                        }
                    } catch (_) { }
                }
            }
        }
    } catch (err) {
        console.error("Error reading stream:", err);
    }
}

function panelElemId(id) {
    return document.getElementById("ds-token--" + id);
}

function processUsageData(usage) {
    if (!usage) return;

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || 0;

    const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens || 0;

    const cacheHit = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss = usage.prompt_cache_miss_tokens || 0;

    const responseTokens = completionTokens - reasoningTokens;
    const ratio = promptTokens > 0 ? (cacheHit / promptTokens) * 100 : 0;
    const ratioFormatted = `${ratio.toFixed(1)}%`;

    panelElemId('prompt_tokens').textContent = promptTokens;
    panelElemId('completion_tokens').textContent = completionTokens;
    panelElemId('total_tokens').textContent = totalTokens;

    // panelElemId('cached_tokens').textContent = cachedTokens;
    panelElemId('reasoning_tokens').textContent = reasoningTokens;
    panelElemId('response_tokens').textContent = responseTokens;

    panelElemId('prompt_cache_hit_tokens').textContent = cacheHit;
    panelElemId('prompt_cache_miss_tokens').textContent = cacheMiss;
    panelElemId('cache_ratio').textContent = ratioFormatted;
}

jQuery(async () => {
    log("Loaded.");

    const panelHtml = await $.get(`${extensionFolderPath}/panel.html`);
    $("#extensions_settings2").append(panelHtml);

    overrideFetch();
});
