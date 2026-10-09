import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFileBriefing, fileBriefingText } from '../brief/briefing.js';
import { matchLessons, readLessons, scopeLesson, writeLessons, type ReviewLesson } from './lessons.js';

const REPO_STANDARDS = 10; // the cap lessons.ts serves
import { describeLesson, lessonsForDiff, lessonView } from './team-lessons.js';

const lesson = (id: string, file: string, text: string, prs: number[], extra: Partial<ReviewLesson> = {}): ReviewLesson => ({
    id, text, file, symbols: ['loadOrders', 'status'], state: 'verified', createdAt: '', updatedAt: '',
    evidence: prs.map(pr => ({ kind: 'point' as const, pr, comment: `${id}-${pr}`, author: 'senior-reviewer' })), ...extra,
});
// A new file no lesson was learned on, with no word or symbol in common with any of them.
const newFile = { files: ['src/reports.ts'], symbols: new Set(['weeklyReport', 'renderTotals']) };

describe('how far a lesson reaches', () => {
    it('a lesson a person made a repository standard reaches every change; one left on its file does not', () => {
        const scan = lesson('scan', 'src/orders.ts', 'Filter in the query, not after a full read.', [1, 6], { scope: 'repo' });
        const echo = lesson('echo', 'src/inventory.ts', 'Do not echo identifiers from config objects into logs.', [2]);
        expect(matchLessons([scan, echo], newFile).map(l => l.id)).toEqual(['scan']);
        expect(describeLesson(lessonView(scan))).toBe('team standard (learned on src/orders.ts): Filter in the query, not after a full read. (acted on in PR #1, #6)');
    });

    it('serves at most ten repository standards, the most-raised first, and only lessons', () => {
        const many = Array.from({ length: REPO_STANDARDS + 2 }, (_, i) => lesson(`r${i}`, `src/m${i}.ts`, `Rule number ${i} for the team.`, Array.from({ length: i + 1 }, (_, n) => n + 1), { scope: 'repo' }));
        const served = matchLessons(many, newFile).map(l => l.id);
        expect(served).toEqual(Array.from({ length: REPO_STANDARDS }, (_, i) => `r${REPO_STANDARDS + 1 - i}`));
        const candidate = lesson('cand', 'src/a.ts', 'Not yet a lesson.', [1], { scope: 'repo', state: 'candidate' });
        expect(matchLessons([candidate], newFile)).toEqual([]);
        expect(matchLessons([candidate], newFile, { includeCandidates: true }).map(l => l.id)).toEqual(['cand']);
    });

    it('a lesson widened to its folder reaches every change in that folder, and no other', () => {
        const folder = lesson('fold', 'src/orders.ts', 'Bound both ends of the window.', [3], { scope: 'folder' });
        expect(matchLessons([folder], newFile).map(l => l.id)).toEqual(['fold']);
        expect(matchLessons([folder], { files: ['lib/reports.ts'], symbols: new Set() })).toEqual([]);
        expect(describeLesson({ ...lessonView(folder), prs: [] })).toBe('src/ (every file): Bound both ends of the window.');
    });
});

describe('a person scoping a lesson', () => {
    let repo: string;
    beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-scope-')); });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('is recorded with who and why, can be taken back to the file, and a team standard has no folder', () => {
        writeLessons(repo, [lesson('scan', 'src/orders.ts', 'Filter in the query.', [1]), lesson('std', '', 'Bound every window.', [2])]);
        expect(scopeLesson(repo, 'scan', 'repo', 'lead@team.example', 'the reviewer raises it everywhere')?.scope).toBe('repo');
        expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'scoped', author: 'lead@team.example', detail: 'repo: the reviewer raises it everywhere' });
        expect(readLessons(repo)[0].state).toBe('verified'); // a scope says nothing about whether it is right
        expect(scopeLesson(repo, 'scan', 'file', 'lead@team.example')?.scope).toBeUndefined();
        expect(() => scopeLesson(repo, 'std', 'folder', 'lead@team.example')).toThrow('a team standard has no folder');
        expect(scopeLesson(repo, 'missing', 'repo', 'lead@team.example')).toBeUndefined();
    });

    it("reaches the brief on a new file's first edit and the judge's lessons for a change to it", () => {
        writeLessons(repo, [lesson('scan', 'src/orders.ts', 'Filter in the query, not after a full read.', [1, 6], { scope: 'repo' }), lesson('echo', 'src/inventory.ts', 'Pick the fields you log.', [2])]);
        expect(fileBriefingText(buildFileBriefing(repo, 'src/reports.ts'))).toBe([
            'Rigour, before you edit src/reports.ts: what this team asks of this file.',
            '1. team standard (learned on src/orders.ts): Filter in the query, not after a full read. (learned in PR #1, #6)',
        ].join('\n'));
        const diff = 'diff --git a/src/reports.ts b/src/reports.ts\n--- /dev/null\n+++ b/src/reports.ts\n@@ -0,0 +1 @@\n+export const weeklyReport = 1;\n';
        expect(lessonsForDiff(repo, diff, 'verified', 15, 30, 3).map(l => l.id)).toEqual(['scan']);
    });
});
