import { EXTENSION_NAME } from "./constants.js";

export function log(...args) {
    console.log(`[${EXTENSION_NAME}]`, ...args);
}
["warn", "error"].forEach(item => {
    log[item] = function (...args) {
        console[item](`[${EXTENSION_NAME}]`, ...args);
    }
});

export function debounce(func, timeout = 300){
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => { func.apply(this, args); }, timeout);
    };
}

export function timeToInt(time) {
    const splitTime = time.split(":");
    const hour = parseInt(splitTime[0]);
    const minute = parseInt(splitTime[1]);

    return (hour * 60) + minute;
}

export function modelNameToHsl(name, saturation = 70, lightness = 60) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

export function numberComma(number) {
    return number.toLocaleString();
}

export function isTimeTargetBetween(start, end, value) {
    if (start > end) {
        return start <= value || end >= value;
    } else {
        return start <= value && end >= value;
    }
}
