import { panelElemId, renderUIDebounced } from "./html.js";
import { peakTimes, setPeakTimes } from "./globals.js";
import { log, debounce, timeToInt, isTimeTargetBetween } from "./utils.js";
import { PEAK_WEEKDAY_KEYS, DEFAULT_PEAK_WEEKDAYS } from "./defaults.js";
import { savePeakTimesToLocalStorageDebounced } from "./storage.js";

export const savePeakTimeEditorDebounced = debounce(savePeakTimeEditor, 300);
function savePeakTimeEditor() {
    log("Saving peak time editor values.");

    const entries = panelElemId("peakTimeEditorRows").querySelectorAll(".peak-time-entry");
    const newTimes = [];

    entries.forEach(entry => {
        const start = entry.querySelector('[data-field="start"]').value;
        const end = entry.querySelector('[data-field="end"]').value;

        if (!start || !end) return;

        const weekdays = {};
        entry.querySelectorAll('[data-day]').forEach(button => {
            weekdays[button.dataset.day] = button.classList.contains("active");
        });

        newTimes.push({ start, end, weekdays });
    });

    setPeakTimes(newTimes);

    savePeakTimesToLocalStorageDebounced();
    updatePeakTimeIndicators();
    renderUIDebounced();
}

export function populatePeakTimeEditor() {
    const rowsContainer = panelElemId("peakTimeEditorRows");
    rowsContainer.innerHTML = "";

    peakTimes.forEach(entry => {
        rowsContainer.appendChild(createPeakTimeEntry(entry.start, entry.end, entry.weekdays));
    });
}

function createPeakTimeEntry(start, end, weekdays) {
    const container = document.createElement("div");
    container.className = "peak-time-entry";

    const timesRow = document.createElement("div");
    timesRow.className = "settings-editor-row";
    timesRow.appendChild(createTimeInput(start, "start"));
    timesRow.appendChild(createTimeInput(end, "end"));

    const weekdayRow = document.createElement("div");
    weekdayRow.className = "settings-editor-row weekday-row";
    weekdayRow.title = "Peak applies only on the selected days (UTC)";

    const weekdayLabel = document.createElement("span");
    weekdayLabel.className = "weekday-label";
    weekdayLabel.textContent = "Days";
    weekdayRow.appendChild(weekdayLabel);

    PEAK_WEEKDAY_KEYS.forEach(day => {
        weekdayRow.appendChild(createWeekdayButton(day, weekdays[day]));
    });

    container.appendChild(timesRow);
    container.appendChild(weekdayRow);

    return container;
}

function createWeekdayButton(day, active) {
    const label = day[0].toUpperCase() + day.slice(1);

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.day = day;
    button.className = "weekday-btn menu_button" + (active ? " active" : "");
    button.textContent = label;

    return button;
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

export function addTimeRow() {
    const rowsContainer = panelElemId("peakTimeEditorRows");
    const entry = createPeakTimeEntry("", "", DEFAULT_PEAK_WEEKDAYS);
    rowsContainer.appendChild(entry);
    entry.querySelector("input").focus();
}

export function onPeakTimeEditorClick(event) {
    const button = event.target.closest('[data-day]');
    if (button) {
        button.classList.toggle("active");
    }

    savePeakTimeEditorDebounced();
}

export function updatePeakTimeIndicators() {
    const activePeakHours = getActivatedPeakHours();
    log("Peak hours list", activePeakHours);
    showPeakTimeInTitleBadge(activePeakHours);
    showCurrentUTCTime(activePeakHours);
}

function showPeakTimeInTitleBadge(activePeakHours) {
    const icon = panelElemId("header-badge");

    icon.style.color = activePeakHours.length ? "orange" : "green";
}

function showCurrentUTCTime(activePeakHours) {
    const currentTime = new Date();
    const hour = currentTime.getUTCHours().toString().padStart(2, "0");
    const minute = currentTime.getUTCMinutes().toString().padStart(2, "0");
    const formattedTime = `${hour}:${minute}`;

    let msg;

    if (activePeakHours.length) {
        const firstPeakHours = activePeakHours[0];
        let timeLeft = timeToInt(firstPeakHours.end) - timeToInt(formattedTime);
        if (timeLeft < 0) timeLeft += 1440; // 24h * 60m

        msg = `[ ${formattedTime} ] On peak hours! ${timeLeft} minute${ timeLeft == 1 ? "" : "s" } left.`;
    } else {
        msg = `[ ${formattedTime} ] Click to refresh time.`;
    }

    panelElemId("timeInUtcBtn").innerHTML = msg;
}

export function getActivatedPeakHours() {
    const currentTime = new Date();
    const hour = currentTime.getUTCHours();
    const minute = currentTime.getUTCMinutes();
    const currentTimeUTC = timeToInt(`${hour}:${minute}`);
    const today = PEAK_WEEKDAY_KEYS[currentTime.getUTCDay()];

    return peakTimes.filter(entry => {
        if (!entry.weekdays[today]) return false;

        const start = timeToInt(entry.start);
        const end = timeToInt(entry.end);
        return isTimeTargetBetween(start, end, currentTimeUTC);
    });
}
