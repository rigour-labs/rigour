import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getScoreTrend, type ScoreEntry } from './score-history.js';

describe('getScoreTrend', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-history-test-'));
        fs.mkdirSync(path.join(testDir, '.rigour'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    function writeScores(scores: number[]): void {
        const entries = scores.map((score, index): ScoreEntry => ({
            timestamp: new Date(index * 1000).toISOString(),
            status: 'FAIL',
            score,
            failureCount: 1,
            severity_breakdown: {},
            provenance_breakdown: {},
        }));
        fs.writeFileSync(
            path.join(testDir, '.rigour', 'score-history.jsonl'),
            entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
        );
    }

    it('labels the displayed rising scores as improving despite a higher older window', () => {
        writeScores([90, 92, 94, 96, 98, 34, 29, 29, 52, 59]);

        expect(getScoreTrend(testDir)).toMatchObject({
            direction: 'improving',
            delta: -53.4,
            visibleDelta: 25,
            recentScores: [34, 29, 29, 52, 59],
            recentAvg: 41,
            previousAvg: 94,
        });
    });

    it('labels a falling displayed series as degrading', () => {
        writeScores([80, 75, 70, 64, 59]);

        expect(getScoreTrend(testDir)).toMatchObject({
            direction: 'degrading',
            delta: 0,
            visibleDelta: -21,
        });
    });

    it('treats small visible changes as stable', () => {
        writeScores([50, 49, 52, 51, 53]);

        expect(getScoreTrend(testDir)).toMatchObject({
            direction: 'stable',
            delta: 0,
            visibleDelta: 3,
        });
    });
});
