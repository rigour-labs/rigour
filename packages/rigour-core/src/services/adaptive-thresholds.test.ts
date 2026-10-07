import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    recordGateRun,
    getQualityTrend,
    clearAdaptiveHistory,
} from './adaptive-thresholds.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('AdaptiveThresholds', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaptive-test-'));
    });

    afterEach(() => {
        clearAdaptiveHistory(testDir);
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('historical tracking', () => {
        it('should record gate runs', () => {
            recordGateRun(testDir, 5, 2, 10);
            recordGateRun(testDir, 6, 1, 5);

            const historyPath = path.join(testDir, '.rigour', 'adaptive-history.json');
            expect(fs.existsSync(historyPath)).toBe(true);

            const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
            expect(history.runs).toHaveLength(2);
        });

        it('should return stable trend for new projects', () => {
            const trend = getQualityTrend(testDir);
            expect(trend).toBe('stable');
        });

        it('should detect improving trend', () => {
            // Baseline: 15 runs with high failures (with variance for valid std dev)
            for (let i = 0; i < 15; i++) {
                recordGateRun(testDir, 3, 5, 15 + (i % 5) * 3); // 15,18,21,24,27 repeating
            }
            // Recent: 5 runs with very low failures (clear improvement)
            for (let i = 0; i < 5; i++) {
                recordGateRun(testDir, 7, 0, 1);
            }

            const trend = getQualityTrend(testDir);
            expect(trend).toBe('improving');
        });

        it('should detect degrading trend', () => {
            // Baseline: 15 runs with low failures (with variance for valid std dev)
            for (let i = 0; i < 15; i++) {
                recordGateRun(testDir, 7, 1, 1 + (i % 3)); // 1,2,3 repeating
            }
            // Recent: 5 runs with high failures (clear degradation)
            for (let i = 0; i < 5; i++) {
                recordGateRun(testDir, 3, 5, 25);
            }

            const trend = getQualityTrend(testDir);
            expect(trend).toBe('degrading');
        });
    });
});
