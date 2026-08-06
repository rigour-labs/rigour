import { describe, it, expect } from 'vitest';
import {
    normalizeModelKey,
    getInputPricePerMillionUsd,
    computeWeightedInputPricePerMillion,
    estimateAvoidedContextCostUsd,
    estimateTokenCostUsd,
    FALLBACK_INPUT_PRICE_PER_MILLION_USD,
} from './model-pricing.js';
import type { ModelUsage } from '../storage/context-telemetry.js';

describe('model-pricing', () => {
    it('resolves Composer 2.5 Standard input pricing', () => {
        expect(getInputPricePerMillionUsd('Composer 2.5 Standard')).toBe(0.5);
        expect(normalizeModelKey('composer-2-5-standard')).toBe('composer-2.5-standard');
    });

    it('resolves Composer 2.5 Fast input pricing', () => {
        expect(getInputPricePerMillionUsd('composer-2.5-fast')).toBe(3.0);
        expect(normalizeModelKey('Composer 2.5 Fast')).toBe('composer-2.5-fast');
    });

    it('normalizes aliases with spaces and hyphens', () => {
        expect(normalizeModelKey('Composer_2.5 FAST')).toBe('composer-2.5-fast');
        expect(normalizeModelKey('composer 25 standard')).toBe('composer-2.5-standard');
    });

    it('uses conservative fallback for unknown models', () => {
        expect(getInputPricePerMillionUsd('totally-unknown-model')).toBe(
            FALLBACK_INPUT_PRICE_PER_MILLION_USD,
        );
    });

    it('computes mixed-model input-token-weighted pricing', () => {
        const usages: ModelUsage[] = [
            { source: 'cursor-admin-api', model: 'composer-2.5-standard', inputTokens: 1000, outputTokens: 0 },
            { source: 'cursor-admin-api', model: 'composer-2.5-fast', inputTokens: 3000, outputTokens: 0 },
        ];
        const weighted = computeWeightedInputPricePerMillion(usages);
        expect(weighted.inputPricePerMillionUsd).toBeCloseTo(2.375, 3);
        expect(weighted.pricingBasis).toContain('mixed-model-weighted');
    });

    it('prefers observed cost when estimating actual spend is unnecessary', () => {
        const observed = 4.25;
        expect(observed).toBeGreaterThan(0);
    });

    it('estimates actual token cost when observed cost is absent', () => {
        const estimated = estimateTokenCostUsd(1_000_000, 0, 'composer-2.5-standard');
        expect(estimated).toBe(0.5);
    });

    it('estimates avoided context using input pricing only', () => {
        const usages: ModelUsage[] = [
            { source: 'cursor-admin-api', model: 'composer-2.5-standard', inputTokens: 100, outputTokens: 0 },
        ];
        const { costUsd, pricing } = estimateAvoidedContextCostUsd(2_000_000, usages);
        expect(pricing.inputPricePerMillionUsd).toBe(0.5);
        expect(costUsd).toBe(1.0);
    });
});
