import { describe, expect, it } from 'vitest';
import { exitCodeFor, EXIT_FAIL, EXIT_INTERNAL_ERROR, EXIT_PASS } from './exit-codes.js';

const report = (status: 'PASS' | 'FAIL', deepStatus?: 'ok' | 'partial' | 'error') => ({
    status,
    stats: { duration_ms: 1, ...(deepStatus ? { deep: { enabled: true, status: deepStatus } } : {}) },
}) as any;

describe('exitCodeFor', () => {
    it('maps PASS and FAIL to 0 and 1', () => {
        expect(exitCodeFor(report('PASS'))).toBe(EXIT_PASS);
        expect(exitCodeFor(report('FAIL'))).toBe(EXIT_FAIL);
    });

    it('exits 3 when deep analysis was requested but did not run', () => {
        expect(exitCodeFor(report('FAIL', 'error'))).toBe(EXIT_INTERNAL_ERROR);
        expect(exitCodeFor(report('PASS', 'error'))).toBe(EXIT_INTERNAL_ERROR);
    });

    it('keeps the normal code for completed or partial deep runs', () => {
        expect(exitCodeFor(report('PASS', 'ok'))).toBe(EXIT_PASS);
        expect(exitCodeFor(report('FAIL', 'partial'))).toBe(EXIT_FAIL);
    });
});
