import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { writeJsonAtomic } from '../utils/file-lock.js';
import { decideLesson, lessonState, readLessons, readStoredLessons, type ReviewLesson } from './lessons.js';
import { seedLessons } from './seed-lessons.test-support.js';
import { foldTeamDecisions, teamDecisionCachePath, type ReceivedDecision, type TeamDecisionCache } from './team-decisions.js';

const ME = 'lead@example.com';
const lesson = (extra: Partial<ReviewLesson> = {}): ReviewLesson => ({
    id: 'a1b2c3d4e5f6', text: 'Filter in the query.', file: 'src/orders.ts', symbols: [], state: 'verified', promotedBy: 'person', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    evidence: [
        { kind: 'point', pr: 7, comment: '9001', author: 'reviewer', source: 'person' },
        { kind: 'accepted', pr: 7, comment: 'accepted-1', author: ME, at: '2026-01-02T00:00:00Z' },
    ],
    ...extra,
});
const received = (extra: Partial<ReceivedDecision>): ReceivedDecision => ({
    id: 'r1', lessonId: 'a1b2c3d4e5f6', kind: 'rejected', name: 'Omar K.', decidedAt: '2026-01-03T00:00:00Z', receivedAt: '2026-01-03T00:00:01Z', detail: '', points: [], ...extra,
});
const cache = (decisions: ReceivedDecision[], sharing: TeamDecisionCache['sharing'], mine: Record<string, string> = {}): TeamDecisionCache => ({ version: 1, sharing, decisions, mine });

describe('folding the team\'s decisions into the lessons', () => {
    it('my decision this machine will still send holds over a later team decision until it comes back', () => {
        const [held] = foldTeamDecisions([lesson()], cache([received({})], { shares: true, person: ME }), lessonState);
        expect(held.state).toBe('verified');
        const [back] = foldTeamDecisions([lesson()], cache([received({})], { shares: true, person: ME }, { [`a1b2c3d4e5f6\u0000accepted\u0000accepted-1`]: '2026-01-02T12:00:00Z' }), lessonState);
        expect(back.state).toBe('rejected');
    });

    it('a decision this machine never sends is ordered by when it was made', () => {
        const [later] = foldTeamDecisions([lesson()], cache([received({})], { shares: false, reason: 'member' }), lessonState);
        expect(later.state).toBe('rejected');
        const [earlier] = foldTeamDecisions([lesson()], cache([received({ receivedAt: '2026-01-01T00:00:00Z' })], { shares: false }), lessonState);
        expect(earlier.state).toBe('verified');
    });

    it('a teammate\'s later scope and rewording apply; the stored lessons are not changed', () => {
        const stored = [lesson()];
        const [folded] = foldTeamDecisions(stored, cache([
            received({ id: 's', kind: 'scoped', detail: 'repo: every writer' }),
            received({ id: 'w', kind: 'reworded', text: 'Filter rows in the query, never after a full read.', receivedAt: '2026-01-03T00:00:02Z' }),
        ], { shares: false }), lessonState);
        expect(folded).toMatchObject({ scope: 'repo', text: 'Filter rows in the query, never after a full read.', state: 'verified' });
        expect(stored[0]).toMatchObject({ text: 'Filter in the query.', evidence: expect.not.arrayContaining([expect.objectContaining({ team: expect.anything() })]) });
        expect(stored[0].scope).toBeUndefined();
    });

    it('a decision on a lesson this clone never learned, with no wording, is not shown', () => {
        expect(foldTeamDecisions([], cache([received({ lessonId: 'ffffffffffff' })], { shares: false }), lessonState)).toEqual([]);
    });
});

describe('deciding on a lesson known only from the team', () => {
    let repo: string;
    let home: string;
    const saved = process.env.RIGOUR_HOME;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'team-adopt-'));
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-adopt-home-'));
        process.env.RIGOUR_HOME = home;
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/api']);
        seedLessons(repo, []);
        const file = teamDecisionCachePath(repositoryIdSync(repo));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJsonAtomic(file, cache([received({ id: 'r9', lessonId: 'ffffffffffff', kind: 'accepted', text: 'Close every cursor in a finally block.', points: [{ pr: 3, comment: '77', source: 'person' }] })], { shares: false }));
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = saved;
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('is served from the team, and a person\'s decision on it takes it into the store without the team\'s rows', () => {
        expect(readStoredLessons(repo)).toEqual([]);
        expect(readLessons(repo)[0]).toMatchObject({ id: 'ffffffffffff', state: 'verified' });
        expect(decideLesson(repo, 'ffffffffffff', 'rejected', ME, 'not here')?.state).toBe('rejected');
        const [stored] = readStoredLessons(repo);
        expect(stored.evidence.map(e => e.kind)).toEqual(['point', 'rejected']);
        expect(JSON.stringify(stored)).not.toContain('Omar');
        expect(readLessons(repo)[0].state).toBe('rejected'); // not shared: ordered by when it was made, after the team's
    });
});
