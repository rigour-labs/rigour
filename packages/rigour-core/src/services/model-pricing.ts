/**
 * Model-aware input pricing for context cost telemetry.
 * Observed Cursor costs always take precedence; these rates estimate when absent.
 */

import type { ModelUsage } from '../storage/context-telemetry.js';

export interface ModelPricingTier {
    label: string;
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
}

/** Per-million-token USD rates. Input rates drive avoided-context estimates. */
export const MODEL_PRICING: Record<string, ModelPricingTier> = {
    'composer-2.5-standard': {
        label: 'Composer 2.5 Standard',
        inputPerMillionUsd: 0.5,
        outputPerMillionUsd: 2.5,
    },
    'composer-2.5-fast': {
        label: 'Composer 2.5 Fast',
        inputPerMillionUsd: 3.0,
        outputPerMillionUsd: 15.0,
    },
    'claude-3-5-sonnet': {
        label: 'Claude 3.5 Sonnet',
        inputPerMillionUsd: 3.0,
        outputPerMillionUsd: 15.0,
    },
    'gpt-4o': {
        label: 'GPT-4o',
        inputPerMillionUsd: 2.5,
        outputPerMillionUsd: 10.0,
    },
    'gpt-4o-mini': {
        label: 'GPT-4o Mini',
        inputPerMillionUsd: 0.15,
        outputPerMillionUsd: 0.6,
    },
    'o1-preview': {
        label: 'o1 Preview',
        inputPerMillionUsd: 15.0,
        outputPerMillionUsd: 60.0,
    },
};

/** Conservative fallback when model cannot be resolved (USD per 1M input tokens). */
export const FALLBACK_INPUT_PRICE_PER_MILLION_USD = 3.0;
export const FALLBACK_OUTPUT_PRICE_PER_MILLION_USD = 15.0;

const MODEL_ALIASES: Record<string, string> = {
    'composer-2.5': 'composer-2.5-standard',
    'composer-25-standard': 'composer-2.5-standard',
    'composer-25-fast': 'composer-2.5-fast',
    'composer-2-5-standard': 'composer-2.5-standard',
    'composer-2-5-fast': 'composer-2.5-fast',
    'composer25standard': 'composer-2.5-standard',
    'composer25fast': 'composer-2.5-fast',
};

/**
 * Normalize model identifiers from Cursor, CLI flags, or imports.
 */
export function normalizeModelKey(model: string | undefined): string {
    if (!model) return 'unknown';
    const lowered = model.trim().toLowerCase();
    const compact = lowered
        .replace(/[_\s]+/g, '-')
        .replace(/[^a-z0-9.-]/g, '')
        .replace(/-+/g, '-');

    if (MODEL_ALIASES[compact]) {
        return MODEL_ALIASES[compact];
    }

    if (compact.includes('composer') && compact.includes('fast')) {
        return 'composer-2.5-fast';
    }
    if (compact.includes('composer')) {
        return 'composer-2.5-standard';
    }
    if (compact.includes('claude') && compact.includes('sonnet')) {
        return 'claude-3-5-sonnet';
    }
    if (compact.includes('gpt-4o-mini') || compact.includes('gpt4omini')) {
        return 'gpt-4o-mini';
    }
    if (compact.includes('gpt-4o') || compact.includes('gpt4o')) {
        return 'gpt-4o';
    }
    if (compact.includes('o1-preview') || compact.includes('o1preview')) {
        return 'o1-preview';
    }

    return compact;
}

export function getModelPricing(model: string | undefined): ModelPricingTier | undefined {
    const key = normalizeModelKey(model);
    return MODEL_PRICING[key];
}

export function getInputPricePerMillionUsd(model: string | undefined): number {
    return getModelPricing(model)?.inputPerMillionUsd ?? FALLBACK_INPUT_PRICE_PER_MILLION_USD;
}

export function getOutputPricePerMillionUsd(model: string | undefined): number {
    return getModelPricing(model)?.outputPerMillionUsd ?? FALLBACK_OUTPUT_PRICE_PER_MILLION_USD;
}

export interface WeightedInputPricing {
    inputPricePerMillionUsd: number;
    pricingBasis: string;
    isEstimated: boolean;
}

/**
 * Input-token-weighted effective input price across observed model usages.
 */
export function computeWeightedInputPricePerMillion(usages: ModelUsage[]): WeightedInputPricing {
    const withInput = usages.filter(u => (u.inputTokens || 0) > 0 && u.model);
    if (withInput.length === 0) {
        return {
            inputPricePerMillionUsd: FALLBACK_INPUT_PRICE_PER_MILLION_USD,
            pricingBasis: 'conservative-fallback-unknown-model',
            isEstimated: true,
        };
    }

    let weightedSum = 0;
    let totalInput = 0;
    const modelsUsed = new Set<string>();

    for (const usage of withInput) {
        const tokens = usage.inputTokens || 0;
        const price = getInputPricePerMillionUsd(usage.model);
        weightedSum += price * tokens;
        totalInput += tokens;
        modelsUsed.add(normalizeModelKey(usage.model));
    }

    const effective = totalInput > 0 ? weightedSum / totalInput : FALLBACK_INPUT_PRICE_PER_MILLION_USD;
    const basis = modelsUsed.size === 1
        ? `model:${Array.from(modelsUsed)[0]}`
        : `mixed-model-weighted:${Array.from(modelsUsed).join(',')}`;

    return {
        inputPricePerMillionUsd: effective,
        pricingBasis: basis,
        isEstimated: true,
    };
}

export function estimateTokenCostUsd(
    inputTokens: number,
    outputTokens: number,
    model: string | undefined,
): number {
    const inputPrice = getInputPricePerMillionUsd(model);
    const outputPrice = getOutputPricePerMillionUsd(model);
    const inputCost = (inputTokens / 1_000_000) * inputPrice;
    const outputCost = (outputTokens / 1_000_000) * outputPrice;
    return parseFloat((inputCost + outputCost).toFixed(4));
}

export function estimateAvoidedContextCostUsd(
    avoidedInputTokens: number,
    usages: ModelUsage[],
): { costUsd: number; pricing: WeightedInputPricing } {
    const pricing = computeWeightedInputPricePerMillion(usages);
    const costUsd = parseFloat(
        ((avoidedInputTokens / 1_000_000) * pricing.inputPricePerMillionUsd).toFixed(4),
    );
    return { costUsd, pricing };
}
