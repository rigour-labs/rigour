import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    detectComplexityTier,
    calculateAdaptiveThresholds,
    recordGateRun,
    getQualityTrend,
    clearAdaptiveHistory,
    getAdaptiveSummary,
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

    describe('detectComplexityTier', () => {
        it('should detect hobby tier for small projects', () => {
            const tier = detectComplexityTier({ fileCount: 20 });
            expect(tier).toBe('hobby');
        });

        it('should detect startup tier for medium projects', () => {
            const tier = detectComplexityTier({ fileCount: 100 });
            expect(tier).toBe('startup');
        });

        it('should detect enterprise tier for large projects', () => {
            const tier = detectComplexityTier({ fileCount: 600 });
            expect(tier).toBe('enterprise');
        });

        it('should consider commit count for tier detection', () => {
            const tier = detectComplexityTier({ fileCount: 50, commitCount: 1500 });
            expect(tier).toBe('enterprise');
        });
    });

    describe('calculateAdaptiveThresholds', () => {
        it('should return lenient thresholds for hobby tier', () => {
            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 20 }
            );

            expect(adjustments.tier).toBe('hobby');
            expect(adjustments.coverageThreshold).toBeLessThan(80);
            expect(adjustments.securityBlockLevel).toBe('critical');
            expect(adjustments.leniencyFactor).toBeGreaterThan(0.5);
        });

        it('should return strict thresholds for enterprise tier', () => {
            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 600 }
            );

            expect(adjustments.tier).toBe('enterprise');
            expect(adjustments.coverageThreshold).toBe(80);
            expect(adjustments.securityBlockLevel).toBe('medium');
            expect(adjustments.leniencyFactor).toBeLessThan(0.5);
        });

        it('should respect forced_tier config', () => {
            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 20 },
                { forced_tier: 'enterprise' }
            );

            expect(adjustments.tier).toBe('enterprise');
        });

        it('should include reasoning for adjustments', () => {
            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 100 }
            );

            expect(adjustments.reasoning.length).toBeGreaterThan(0);
            expect(adjustments.reasoning.some(r => r.includes('tier'))).toBe(true);
        });
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

    describe('trend-based adjustments', () => {
        it('should relax thresholds for improving trend', () => {
            // Baseline: 15 runs with high failures (with variance)
            for (let i = 0; i < 15; i++) {
                recordGateRun(testDir, 3, 5, 15 + (i % 5) * 3);
            }
            // Recent: 5 runs with very low failures
            for (let i = 0; i < 5; i++) {
                recordGateRun(testDir, 7, 0, 1);
            }

            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 100 }
            );

            expect(adjustments.trend).toBe('improving');
            expect(adjustments.reasoning.some(r => r.includes('bonus'))).toBe(true);
        });

        it('should tighten thresholds for degrading trend', () => {
            // Baseline: 15 runs with low failures (with variance)
            for (let i = 0; i < 15; i++) {
                recordGateRun(testDir, 7, 1, 1 + (i % 3));
            }
            // Recent: 5 runs with high failures
            for (let i = 0; i < 5; i++) {
                recordGateRun(testDir, 3, 5, 25);
            }

            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 100 }
            );

            expect(adjustments.trend).toBe('degrading');
            expect(adjustments.reasoning.some(r => r.includes('tightened'))).toBe(true);
        });
    });

    describe('getAdaptiveSummary', () => {
        it('should return formatted summary string', () => {
            const adjustments = calculateAdaptiveThresholds(
                testDir,
                { fileCount: 100 }
            );

            const summary = getAdaptiveSummary(adjustments);
            expect(summary).toContain('STARTUP');
            expect(summary).toContain('Coverage:');
            expect(summary).toContain('Quality:');
        });
    });
});
