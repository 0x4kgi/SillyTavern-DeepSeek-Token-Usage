import { DEFAULT_COST } from "./defaults.js";
import { setDeepseekCost, deepseekCost } from "./globals.js";
import { panelElemId, populateModelSelector, renderUIDebounced } from "./html.js";
import { saveDeepSeekCostToLocalStorageDebounced } from "./storage.js";
import { debounce, log } from "./utils.js";

export function priceEditorInit() {
    populatePriceEditor();

    panelElemId("priceEditorRows").addEventListener("input", savePriceEditorDebounced);
    panelElemId("addModelBtn").addEventListener("click", addModelRow);
}

export const savePriceEditorDebounced = debounce(savePriceEditor, 300);
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

export function populatePriceEditor() {
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

export function addModelRow() {
    const rowsContainer = panelElemId("priceEditorRows");
    const entry = createPriceRow("", DEFAULT_COST);

    rowsContainer.appendChild(entry);
    entry.querySelector("input").focus();
}
