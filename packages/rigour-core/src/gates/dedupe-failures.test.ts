import { describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { dedupeFailures } from './runner.js';

const finding = (title: string, line = 3): Failure => ({ id: 'semantic-bugs', title, details: '', severity: 'high', provenance: 'traditional', files: ['src/a.ts'], line });

describe('dedupeFailures', () => {
    it('keeps a learned rule that fires on the same line as a built-in rule of the same gate', () => {
        const kept = dedupeFailures([finding('credential-redirect'), finding('learned-rule: require-option-redirect')]);
        expect(kept.map(f => f.title)).toEqual(['credential-redirect', 'learned-rule: require-option-redirect']);
    });

    it('still drops the same rule reported twice on one line', () => {
        expect(dedupeFailures([finding('credential-redirect'), finding('credential-redirect'), finding('credential-redirect', 9)])).toHaveLength(2);
    });
});
