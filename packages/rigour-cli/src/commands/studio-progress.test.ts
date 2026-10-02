import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Story } from '@rigour-labs/core';
import { buildProgress, precisionsAcross } from './studio-progress.js';
import type { StudioLearning } from './studio-learning.js';

const now = new Date('2026-10-09T12:00:00Z');
const story = (openedAt: string, at: string): Story => ({ id: at, at, openedAt, stage: 'edit', file: 'a.ts', rule: 'r', title: 't', diff: [] });
const learning: StudioLearning = {
    prRecorded: false,
    weeks: [{ from: '2026-09-25T12:00:00Z', stoppedInDevelopment: 0, reachedPr: null }, { from: '2026-10-02T12:00:00Z', stoppedInDevelopment: 2, reachedPr: null }],
    lessons: [
        { id: 'a', text: 'Never follow redirects with credentials', origin: 'development', learnedFrom: '', learnedAt: '2026-09-26T00:00:00Z', state: 'validated', scope: 'team', told: 3, stoppedInDevelopment: 2, reachedPr: null, canDecide: false },
        { id: 'b', text: 'Amounts are cents', origin: 'development', learnedFrom: '', learnedAt: '2026-10-05T00:00:00Z', state: 'candidate', scope: 'this repo', told: 0, stoppedInDevelopment: 0, reachedPr: null, canDecide: true },
    ],
};

describe('buildProgress', () => {
    it('reports each week from records: stopped, overruled, median time to fix, lessons so far', () => {
        const progress = buildProgress({
            now,
            stories: [story('2026-10-03T10:00:00Z', '2026-10-03T10:02:00Z'), story('2026-10-04T10:00:00Z', '2026-10-04T10:10:00Z'), story('2026-09-27T09:00:00Z', '2026-09-27T09:04:00Z')],
            dismissals: [{ key: 'k', reason: 'x', at: '2026-10-05T00:00:00Z' }],
            learning,
            checks: [],
        });
        expect(progress.weeks).toEqual([
            { from: '2026-09-25T12:00:00Z', stopped: 1, overruled: 0, repeatsStopped: 0, repeatsReachedPr: null, minutesToFix: 4, lessons: 1 },
            { from: '2026-10-02T12:00:00Z', stopped: 2, overruled: 1, repeatsStopped: 2, repeatsReachedPr: null, minutesToFix: 6, lessons: 2 },
        ]);
        expect(progress.topLessons.map(l => l.id)).toEqual(['a']);
    });

    it('ranks checks by how often their findings were acted on, summed over every checkout', () => {
        const roots = [0, 1].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'progress-')));
        roots.forEach((root, i) => {
            fs.mkdirSync(path.join(root, '.rigour'));
            fs.writeFileSync(path.join(root, '.rigour', 'check-outcomes.json'), JSON.stringify({ 'security-patterns: Key': { fixed: 2 + i, dismissed: 0 }, 'ast: Too complex': { fixed: 0, dismissed: 3 } }));
        });
        const checks = buildProgress({ now, stories: [], dismissals: [], learning, checks: precisionsAcross(roots) }).checks;
        expect(checks.map(c => [c.check, c.fixed, c.dismissed, c.muted])).toEqual([['security-patterns: Key', 5, 0, false], ['ast: Too complex', 0, 6, true]]);
        roots.forEach(root => fs.rmSync(root, { recursive: true, force: true }));
    });
});
