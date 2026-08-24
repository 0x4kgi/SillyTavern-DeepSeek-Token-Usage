import { Usage, Statistic, deepseekCost } from "./globals.js";
import { log } from "./utils.js";

/**
 * @param {any} usage
 * @returns {Statistic}
 */
export function parseUsageObject(usage) {
    log("Parsing Usage Object...");
    const obj = {
        prompt: usage.prompt_tokens || 0,
        completion: usage.completion_tokens || 0,
        total: usage.total_tokens || 0,
        reasoning: usage.completion_tokens_details?.reasoning_tokens || 0,
        response: 0,
        cacheHit: usage.prompt_cache_hit_tokens || 0,
        cacheMiss: usage.prompt_cache_miss_tokens || 0,
        ratio: 0,
    };
    obj.response = obj.completion - obj.reasoning;

    return obj;
}

/**
 * @param {Statistic} tokens
 * @param {string} modelName
 * @returns {Statistic}
 */
export function calculateTokenCost(tokens, modelName) {
    const tokenPrice = deepseekCost[modelName];

    if (!tokens || !tokenPrice) {
        return structuredClone(Statistic);
    }

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
 * @param {accumulatedUsage} source
 * @returns {Usage}
 */
export function getAllModelStats(source) {
    let accumulated = structuredClone(Usage);
    accumulated.cost ??= structuredClone(Statistic);
    accumulated.extraCost ??= structuredClone(Statistic);

    Object.keys(source.models).forEach(modelName => {
        const modelStats = source.models[modelName];
        Object.keys(modelStats.tokens).forEach(param => {
            accumulated.tokens[param] += modelStats.tokens[param];
        });

        const tokenCost = calculateTokenCost(modelStats.tokens, modelName);
        const extraCost = calculateTokenCost(modelStats.extra, modelName);

        Object.keys(tokenCost).forEach(param => {
            accumulated.cost[param] += tokenCost[param];
            accumulated.extraCost[param] += extraCost[param];
        });
    });

    return accumulated;
}
