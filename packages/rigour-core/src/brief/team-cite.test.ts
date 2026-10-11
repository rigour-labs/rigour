import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewLesson } from '../review-learning/lessons.js';
import { seedLessons } from '../review-learning/seed-lessons.test-support.js';
import { teamDecisionCachePath, type ReceivedDecision } from '../review-learning/team-decisions.js';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { writeJsonAtomic } from '../utils/file-lock.js';
import { buildFileBriefing } from './briefing.js';

const candidate = (id: string, text: string, extra: Partial<ReviewLesson> = {}): ReviewLesson => ({
    id, text, file: 'src/orders.ts', symbols: [], state: 'candidate', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    evidence: [{ kind: 'point', pr: 7, comment: `c-${id}`, author: 'reviewer', source: 'person' }], ...extra,
});
const received = (lessonId: string, kind: ReceivedDecision['kind'], name?: string): ReceivedDecision => ({
    id: `r-${lessonId}`, lessonId, kind, ...(name ? { name } : {}), decidedAt: '2026-01-02T00:00:00Z', receivedAt: '2026-01-02T00:00:01Z', detail: '', points: [],
});

describe('the brief cites a team decision by the teammate\'s display name', () => {
    let repo: string;
    let home: string;
    const saved = process.env.RIGOUR_HOME;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cite-'));
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-cite-home-'));
        process.env.RIGOUR_HOME = home;
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/api']);
        seedLessons(repo, [
            candidate('a1b2c3d4e5f6', 'Use an upsert keyed on the order id.'),
            candidate('b1b2c3d4e5f6', 'Log every request body.'),
            candidate('c1b2c3d4e5f6', 'Bound the batch size of one insert.', { evidence: [
                { kind: 'point', pr: 9, comment: 'c-c1', author: 'reviewer', source: 'person' },
                { kind: 'accepted', pr: 9, comment: 'accepted-1', author: 'me@example.com', at: '2026-01-01T00:00:00Z' },
            ], state: 'verified' }),
        ]);
        const file = teamDecisionCachePath(repositoryIdSync(repo));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJsonAtomic(file, { version: 1, sharing: { shares: false }, mine: {}, decisions: [
            received('a1b2c3d4e5f6', 'accepted', 'Jane D.'),
            received('b1b2c3d4e5f6', 'rejected'),
        ] });
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = saved;
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('approved or rejected by a teammate says who, by display name; a local decision cites its pull requests only', () => {
        const items = buildFileBriefing(repo, 'src/orders.ts').items;
        expect(items.find(i => i.id === 'lesson:a1b2c3d4e5f6')?.cite).toBe('learned in PR #7, approved by Jane D. (team)');
        expect(items.find(i => i.id === 'settled:b1b2c3d4e5f6')?.cite).toBe('learned in PR #7, rejected by a teammate (team)');
        expect(items.find(i => i.id === 'lesson:c1b2c3d4e5f6')?.cite).toBe('learned in PR #9');
    });
});
