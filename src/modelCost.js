import { EXT_PREFIX } from "./constants.js";
import { DEFAULT_COST } from "./defaults.js";
import { setDeepseekCost, deepseekCost } from "./globals.js";
import { panelElemId, buttons, populateModelSelector, renderUIDebounced, htmlStringToElement } from "./html.js";
import { saveDeepSeekCostToLocalStorageDebounced } from "./storage.js";
import { debounce, log } from "./utils.js";

const modelCostHtml = htmlStringToElement(/*html*/ `
<div class="ds-token-usage-popup settings-editor">
    <span>Model Prices</span>
    <hr>
    <div class="settings-editor-row settings-editor-header">
        <span>Model | Cached, Input, Output</span>
    </div>
    <div id="priceEditorRows"></div>
    <button id="addModelBtn" type="button" class="menu_button menu_button_icon interactable">+ Add Model</button>
    <hr>
    <small>Every change is saved automatically.</small>
</div>
`);
const priceEditorRows = modelCostHtml.querySelector(`#${EXT_PREFIX}priceEditorRows`);
const addModelBtn = modelCostHtml.querySelector(`#${EXT_PREFIX}addModelBtn`);

export function priceEditorInit() {
    priceEditorRows.addEventListener("input", savePriceEditorDebounced);
    priceEditorRows.addEventListener("click", deleteModelRow);
    addModelBtn.addEventListener("click", addModelRow);

    panelElemId("open-model-price-popup").addEventListener("click", openModelPricePopup);
}

async function openModelPricePopup() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    populatePriceEditor();

    const popup = new Popup(modelCostHtml, POPUP_TYPE.TEXT);
    await popup.show();
}

export const savePriceEditorDebounced = debounce(savePriceEditor, 300);
function savePriceEditor() {
    log("Saving price editor values.");

    const entries = priceEditorRows.querySelectorAll(".price-entry");
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
    const rowsContainer = priceEditorRows;
    rowsContainer.innerHTML = "";

    Object.keys(deepseekCost).forEach(modelName => {
        const modelCost = deepseekCost[modelName];
        rowsContainer.appendChild(createPriceRow(modelName, modelCost));
    });
}

function createPriceRow(modelName, cost) {
    const container = document.createElement("div");
    container.className = "price-entry";
    container.dataset.model = modelName || "new-model-" + Math.random();

    const modelRow = document.createElement("div");
    modelRow.className = "settings-editor-row";
    modelRow.appendChild(createPriceInput("text", "modelName", modelName));

    const deleteButton = document.createElement("button");
    deleteButton.innerHTML = buttons.delete.innerHTML;
    deleteButton.className = "model" + buttons.delete.className;
    deleteButton.style.color = buttons.delete.color;
    modelRow.appendChild(deleteButton);

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
    const rowsContainer = priceEditorRows;
    const entry = createPriceRow("", DEFAULT_COST);

    rowsContainer.appendChild(entry);
    entry.querySelector("input").focus();
}

/** @param {Event} event*/
function deleteModelRow(event) {
    /** @type {HTMLButtonElement} */
    const button = event.target.closest(".model-delete");
    if (!button) return;

    /** @type {HTMLElement} */
    const modelRow = button.closest("[data-model]");

    // Delete confirmation
    // Revert back to pre-delete confirmation phase and exit
    if (modelRow.classList.contains("delete-candidate")) {
        modelRow.classList.remove("delete-candidate");
        const cb = modelRow.querySelector(".model-delete-confirm");
        if (cb) cb.parentElement.removeChild(cb);

        button.innerHTML = buttons.delete.innerHTML;
        button.style.color = buttons.delete.color;

        return;
    }

    // Delete staging
    modelRow.classList.add("delete-candidate");

    const confirmButton = document.createElement("button");
    confirmButton.innerHTML = buttons.finalDelete.innerHTML;
    confirmButton.className = "model" + buttons.finalDelete.className;
    confirmButton.style.color = buttons.finalDelete.color;

    confirmButton.onclick = () => {
        modelRow.parentElement.removeChild(modelRow);
        savePriceEditor();
        populatePriceEditor();
    };

    button.innerHTML = buttons.recycle.innerHTML;
    button.style.color = buttons.recycle.color;
    button.parentElement.insertBefore(confirmButton, button);
}
