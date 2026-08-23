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
