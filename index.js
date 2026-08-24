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
    log, debounce, timeToInt, numberComma, isTimeTargetBetween, modelNameToHsl
} from "./src/utils.js";
import {
    fetchLifetimeUsageFromLocalStorage,
    saveLifetimeUsageToLocalStorage,
    fetchDeepSeekCostFromLocalStorage,
    saveDeepSeekCostToLocalStorageDebounced,
    fetchPeakTimesFromLocalStorage,
    savePeakTimesToLocalStorageDebounced,
} from "./src/storage.js";
import { panelElemId, panelElemText, renderUIDebounced, updateNonLastStatsOnPanel, populateModelSelector, modelDropdownChange } from "./src/html.js";
import {
    savePeakTimeEditorDebounced, populatePeakTimeEditor, addTimeRow,
    onPeakTimeEditorClick, updatePeakTimeIndicators, getActivatedPeakHours
} from "./src/peakTimes.js";
import { parseUsageObject, calculateTokenCost, saveAggregatedUsage } from "./src/usage.js";

export function overrideFetch() {
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
    panelElemId("timeInUtcBtn").addEventListener("click", updatePeakTimeIndicators);
    panelElemId("addPeakTimeBtn").addEventListener("click", addTimeRow);
    updatePeakTimeIndicators();
    setInterval(updatePeakTimeIndicators, 30000);

    log("Extension loaded!");
});
