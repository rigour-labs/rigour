import { describe, expect, it } from 'vitest';
import { getState, seedFromLastReport, updateScore } from './state.js';

describe('dashboard score', () => {
    it('starts from the last check on disk, labelled as such, until this session runs one', () => {
        seedFromLastReport({ status: 'FAIL', stats: { score: 78, severity_breakdown: { high: 2 } } });
        expect(getState()).toMatchObject({ currentScore: 78, status: 'fail', scoreSource: 'last-report', severityBreakdown: { high: 2 } });

        updateScore(91, 'pass', { low: 1 });
        seedFromLastReport({ status: 'FAIL', stats: { score: 40 } });
        expect(getState()).toMatchObject({ currentScore: 91, status: 'pass', scoreSource: 'session' });
    });

    it('ignores a missing or malformed report', () => {
        const before = { ...getState() };
        seedFromLastReport(null);
        seedFromLastReport({ status: 'PASS', stats: {} });
        expect(getState()).toMatchObject({ currentScore: before.currentScore, scoreSource: before.scoreSource });
    });
});
