import { describe, expect, it } from 'vitest';
import { buildModelInfo, FALLBACK_MODELS, localTier, MODELS } from './types.js';

describe('local model tiers', () => {
    it('picks max over pro over the lite default', () => {
        expect(localTier({})).toBe('lite');
        expect(localTier({ pro: true })).toBe('deep');
        expect(localTier({ max: true })).toBe('max');
        expect(localTier({ max: true, pro: true })).toBe('max');
    });

    it('asks for a published max fine-tune and falls back to the stock 7B coder model', () => {
        expect(buildModelInfo('max', '6.0.0').url)
            .toBe('https://huggingface.co/rigour-labs/rigour-max-v6.0.0-gguf/resolve/main/rigour-max-v6.0.0-q4_k_m.gguf');
        expect(MODELS.max.tier).toBe('max');
        expect(FALLBACK_MODELS.max).toMatchObject({
            filename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
            url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf',
        });
    });
});
