import { describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { mustFix } from './quiet.js';
import { withDiffTestCertainty } from './diff-test-findings.js';

const changed: Failure = { id: 'diff-tests', title: 'Behaviour changed', details: 'total() returns 0 for an empty cart where it returned null', severity: 'medium', provenance: 'deep-analysis', verified: true, files: ['src/cart.ts'], line: 4 };

describe('a behaviour change found by diff tests', () => {
    it('is a note when the change declares no invariant: an intended change differs too', () => {
        const [f] = withDiffTestCertainty([changed], false);
        expect(f.certainty).toBe('likely');
        expect(mustFix(f)).toBe(false);
    });

    it('blocks when the change declares behaviour it keeps', () => {
        const [f] = withDiffTestCertainty([changed], true);
        expect(f.certainty).toBe('proven');
        expect(mustFix(f)).toBe(true);
    });
});
