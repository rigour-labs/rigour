import { describe, expect, it } from 'vitest';
import { defaultTimeout } from './deep-analysis.js';

describe('deep inference timeout', () => {
    it('gives the local 7B tier four minutes a call, the small tiers one, and cloud two', () => {
        expect(defaultTimeout({ enabled: true })).toBe(60_000);
        expect(defaultTimeout({ enabled: true, pro: true })).toBe(60_000);
        expect(defaultTimeout({ enabled: true, max: true })).toBe(240_000);
        expect(defaultTimeout({ enabled: true, apiKey: 'k', provider: 'claude' })).toBe(120_000);
    });
});
