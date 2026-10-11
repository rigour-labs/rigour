import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBriefing, buildFileBriefing } from '../brief/briefing.js';
import { decideLesson, lessonState, readLessons, takeBackable, type ReviewLesson } from './lessons.js';
import { seedLessons } from './seed-lessons.test-support.js';
import { foldTeamDecisions } from './team-decisions.js';

const ME = 'lead@example.com';
const candidate = (id: string, text: string): ReviewLesson => ({
    id, text, file: 'src/orders.ts', symbols: ['saveOrder'], state: 'candidate', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    evidence: [{ kind: 'point', pr: 7, comment: `c-${id}`, author: 'reviewer', source: 'person' }],
});

describe('not a rule, and taking a decision back', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-rule-'));
        execFileSync('git', ['-C', repo, 'init', '-q']);
        seedLessons(repo, [candidate('a1b2c3d4e5f6', 'Bring the import script to the new shape.'), candidate('b1b2c3d4e5f6', 'Use an upsert keyed on the order id.')]);
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

    const served = () => [
        ...buildFileBriefing(repo, 'src/orders.ts', { lessons: 'all' }).items,
        ...buildBriefing(repo, { files: ['src/orders.ts'], goal: 'saveOrder upsert import script shape', lessons: 'all' }).items,
    ];

    it('a one-off task judged not a rule is dropped: never served, and never cited as rejected', () => {
        expect(decideLesson(repo, 'a1b2c3d4e5f6', 'not-a-rule', ME, 'a task for that pull request')?.state).toBe('dropped');
        const ids = served().map(i => i.id);
        expect(ids.some(id => id.endsWith('a1b2c3d4e5f6'))).toBe(false);
        expect(ids).not.toContain('settled:a1b2c3d4e5f6');
        expect(readLessons(repo).find(l => l.id === 'a1b2c3d4e5f6')?.evidence.at(-1)).toMatchObject({ kind: 'not-a-rule', author: ME });
    });

    it('a rejection taken back is a candidate again: nothing served or cited, and the history is kept', () => {
        decideLesson(repo, 'b1b2c3d4e5f6', 'rejected', ME, 'not here');
        expect(served().map(i => i.id)).toContain('settled:b1b2c3d4e5f6');
        expect(decideLesson(repo, 'b1b2c3d4e5f6', 'took-back', ME, 'it was a one-off')?.state).toBe('candidate');
        const lesson = readLessons(repo).find(l => l.id === 'b1b2c3d4e5f6')!;
        expect(lesson.evidence.map(e => e.kind)).toEqual(['point', 'rejected', 'took-back']);
        expect([...new Set(served().map(i => i.id).filter(id => id.endsWith('b1b2c3d4e5f6')))]).toEqual(['lesson:b1b2c3d4e5f6']); // served only as a candidate under `all`
        expect(buildFileBriefing(repo, 'src/orders.ts').items.map(i => i.id)).not.toContain('settled:b1b2c3d4e5f6'); // the default serves no candidate
        expect(takeBackable(lesson)).toBe(false);
    });

    it('takes back only a decision; a promotion taken back stops being served by default', () => {
        expect(() => decideLesson(repo, 'b1b2c3d4e5f6', 'took-back', ME)).toThrow('has no decision to take back');
        decideLesson(repo, 'b1b2c3d4e5f6', 'accepted', ME);
        expect(buildFileBriefing(repo, 'src/orders.ts').items.map(i => i.id)).toContain('lesson:b1b2c3d4e5f6');
        decideLesson(repo, 'b1b2c3d4e5f6', 'took-back', ME);
        expect(buildFileBriefing(repo, 'src/orders.ts').items.map(i => i.id)).not.toContain('lesson:b1b2c3d4e5f6');
    });

    it('a teammate\'s later took-back supersedes an earlier decision, by the latest-wins rule', () => {
        const rejected: ReviewLesson = { ...candidate('c1b2c3d4e5f6', 'Rename the field.'), state: 'rejected', evidence: [
            ...candidate('c1b2c3d4e5f6', 'x').evidence, { kind: 'rejected', pr: 7, comment: 'rejected-1', author: ME, at: '2026-01-02T00:00:00Z' },
        ] };
        const [folded] = foldTeamDecisions([rejected], { version: 1, sharing: { shares: false }, mine: {}, decisions: [
            { id: 'r1', lessonId: 'c1b2c3d4e5f6', kind: 'took-back', name: 'Omar K.', decidedAt: '2026-01-03T00:00:00Z', receivedAt: '2026-01-03T00:00:01Z', detail: '', points: [] },
        ] }, lessonState);
        expect(folded.state).toBe('candidate');
    });
});
