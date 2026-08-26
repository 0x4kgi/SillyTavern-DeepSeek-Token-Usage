import { log, debounce, modelNameToHsl, numberComma } from "./utils.js";
import { EXT_PREFIX } from "./constants.js";
import { calculateTokenCost, getAllModelStats } from "./usage.js";
import {
    sessionLog, Statistic, sessionUsage, lifetimeUsage,
    Usage, accumulatedUsage, deepseekCost
} from "./globals.js";

export const buttons = {
    delete: {
        innerHTML: `<span class="fa-solid fa-trash"></span>`,
        className: "-delete menu_button interactable",
        color: "red",
    },
    finalDelete: {
        innerHTML: `<span class="fa-solid fa-trash"></span>`,
        className: "-delete-confirm menu_button interactable",
        color: "red",
    },
    recycle: {
        innerHTML: `<span class="fa-solid fa-recycle"></span>`,
        className: "-delete menu_button interactable",
        color: "white",
    },
};

export function panelElemId(id) {
    return document.getElementById(EXT_PREFIX + id);
}

export function panelElemText(id, content) {
    const elem = panelElemId(id);

    if (!elem) {
        log.warn(`Element not found: #ds-token--${id}`);
        return;
    }

    elem.textContent = content;
}

export const renderUIDebounced = debounce(renderUI, 150);
function renderUI() {
    updateLastGenerationStats();
    updateNonLastStatsOnPanel("session");
    updateNonLastStatsOnPanel("lifetime");
    updateSessionLogBarChart();
}

export function modelSelectorInit() {
    populateModelSelector();
    panelElemId("modelSelector").addEventListener("change", modelDropdownChange);
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

export function updateNonLastStatsOnPanel(statType = "session") {
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

    let logs = structuredClone(sessionLog);
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

export function populateModelSelector() {
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

export function modelDropdownChange() {
    renderUIDebounced();
}
