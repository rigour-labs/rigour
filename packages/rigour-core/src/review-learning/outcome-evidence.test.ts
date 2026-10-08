import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { gitIn } from './acted-on.js';
import type { PrOutcome } from '../outcomes/outcome.js';
import { applyOutcomeEvidence } from './outcome-evidence.js';
import { lessonState, type LessonEvidence, type ReviewLesson } from './lessons.js';

const point = (pr: number, over: Partial<LessonEvidence> = {}): LessonEvidence => ({ kind: 'point', pr, comment: `c${pr}`, author: `reviewer${pr}`, prAuthor: `author${pr}`, actedOn: false, text: `point ${pr}`, ...over });
function lesson(evidence: LessonEvidence[], file = 'src/job.ts'): ReviewLesson {
    const l: ReviewLesson = { id: 'L1', text: 'take the lock before the first read', file, symbols: [], state: 'candidate', evidence, createdAt: '', updatedAt: '' };
    return Object.assign(l, lessonState(l));
}
function record(pr: number, over: Partial<PrOutcome> = {}): PrOutcome {
    return { pr, mergeSha: `sha${pr}`, mergedAt: '2026-09-01T00:00:00Z', branch: `b${pr}`, author: `author${pr}`, files: ['src/job.ts'], ci: 'success', followUps: [], windowEnd: '2026-10-01T00:00:00Z', settled: true, checkedAt: '2026-10-08T00:00:00Z', ...over };
}
const fix = (file = 'src/job.ts') => ({ sha: 'f1x0000000000000', at: '2026-09-05T00:00:00Z', subject: 'fix: lock first', files: [file], fix: true });
/** Promoted by recurrence: two pull requests, two authors, two reviewers. */
const recurring = () => lesson([point(1), point(2)]);
const none = new Map<number, Set<string>>();

describe('outcome evidence for a lesson', () => {
    it('records a fix on the point\'s file, without a repository to follow its lines in, as followup only, with CI and revert as context', () => {
        const l = lesson([point(1)]);
        applyOutcomeEvidence([l], [record(1, { ci: 'failure', followUps: [fix()] })], none, { demoteAfter: 2 });
        expect(l.evidence.map(e => e.kind)).toEqual(['point', 'followup']);
        expect(l.evidence[1].detail).toContain('not on the point\'s lines; CI regressed on the merge commit');
        expect(l.state).toBe('candidate');
    });

    it('says nothing for a point its pull request acted on, a fix on another file, or a commit that is not a fix', () => {
        const acted = lesson([point(1, { actedOn: true })]);
        const other = lesson([point(1)]);
        const plain = lesson([point(1)]);
        applyOutcomeEvidence([acted], [record(1, { ci: 'failure', followUps: [fix()] })], none, { demoteAfter: 2 });
        applyOutcomeEvidence([other], [record(1, { ci: 'failure', followUps: [fix('src/other.ts')] })], none, { demoteAfter: 2 });
        applyOutcomeEvidence([plain], [record(1, { ci: 'failure', followUps: [{ ...fix(), fix: false, subject: 'tidy up' }] })], none, { demoteAfter: 2 });
        for (const l of [acted, other, plain]) expect(l.evidence.map(e => e.kind)).toEqual(['point']);
    });

    it('adds each piece of evidence once, however often it runs', () => {
        const l = lesson([point(1)]);
        const records = [record(1, { ci: 'failure', followUps: [fix()] })];
        expect(applyOutcomeEvidence([l], records, none, { demoteAfter: 2 }).added).toBe(1);
        expect(applyOutcomeEvidence([l], records, none, { demoteAfter: 2 }).added).toBe(0);
    });
});

describe('taking a lesson back', () => {
    const applied = (...prs: number[]) => new Map(prs.map(pr => [pr, new Set(['L1'])]));

    it('demotes a lesson recurrence promoted after two independent later pull requests a review found repeating it settled clean', () => {
        const l = recurring();
        expect(l).toMatchObject({ state: 'verified', promotedBy: 'recurrence' });
        const result = applyOutcomeEvidence([l], [record(50), record(51)], applied(50, 51), { demoteAfter: 2 });
        expect(l.state).toBe('candidate');
        expect(l.evidence.filter(e => e.kind === 'against').map(e => e.pr)).toEqual([50, 51]);
        expect(l.evidence.find(e => e.kind === 'demoted')?.detail).toBe('taken back: #50, #51 repeated it and settled clean');
        expect(result.demoted).toEqual(['L1']);
    });

    it('never counts a later pull request that followed the lesson, or one no review checked against it', () => {
        const l = recurring();
        applyOutcomeEvidence([l], [record(50), record(51)], new Map([[50, new Set(['another-lesson'])]]), { demoteAfter: 2 });
        expect(l.state).toBe('verified');
        expect(l.evidence.some(e => e.kind === 'against')).toBe(false);
    });

    it('never counts one that did not settle clean: CI failed, a fix on the lesson\'s file, reverted, or the window still open', () => {
        const l = recurring();
        const records = [
            record(50, { ci: 'failure' }),
            record(51, { followUps: [fix()] }),
            record(52, { reverted: { sha: 'r', subject: 'Revert' } }),
            record(53, { settled: false }),
        ];
        applyOutcomeEvidence([l], records, applied(50, 51, 52, 53), { demoteAfter: 2 });
        expect(l.state).toBe('verified');
    });

    it('needs the pull requests to be independent: one author in one week is not enough, and demote_after raises the bar', () => {
        const same = recurring();
        applyOutcomeEvidence([same], [record(50, { author: 'ana' }), record(51, { author: 'ana' })], applied(50, 51), { demoteAfter: 2 });
        expect(same.state).toBe('verified');
        const weeks = recurring();
        applyOutcomeEvidence([weeks], [record(50, { author: 'ana' }), record(51, { author: 'ana', mergedAt: '2026-09-20T00:00:00Z' })], applied(50, 51), { demoteAfter: 2 });
        expect(weeks.state).toBe('candidate');
        // A day apart, across a week bucket's edge (weeks counted from 1970 start on a Thursday): one author, not a week apart.
        const edge = recurring();
        applyOutcomeEvidence([edge], [record(50, { author: 'ana', mergedAt: '2026-09-09T12:00:00Z' }), record(51, { author: 'ana', mergedAt: '2026-09-10T12:00:00Z' })], applied(50, 51), { demoteAfter: 2 });
        expect(edge.state).toBe('verified');
        const three = recurring();
        applyOutcomeEvidence([three], [record(50), record(51)], applied(50, 51), { demoteAfter: 3 });
        expect(three.state).toBe('verified');
    });

    it('never takes back a lesson a person promoted, and a person promoting it again after it was taken back is final', () => {
        const person = lesson([point(1), { kind: 'accepted', pr: 0, comment: 'yes', author: 'lead' }]);
        applyOutcomeEvidence([person], [record(50), record(51)], applied(50, 51), { demoteAfter: 2 });
        expect(person).toMatchObject({ state: 'verified', promotedBy: 'person' });
        const back = recurring();
        applyOutcomeEvidence([back], [record(50), record(51)], applied(50, 51), { demoteAfter: 2 });
        back.evidence.push({ kind: 'accepted', pr: 0, comment: 'promote again', author: 'lead' });
        Object.assign(back, lessonState(back));
        applyOutcomeEvidence([back], [record(50), record(51), record(52, { author: 'z' })], applied(50, 51, 52), { demoteAfter: 2 });
        expect(back).toMatchObject({ state: 'verified', promotedBy: 'person' });
    });
});

describe('promotion by the point\'s own lines', () => {
    /**
     * main: src/job.ts with ten lines; a pull request (#7) merged on day 0 whose review pointed at lines 4-5 and that left
     * them alone; then the later commits each case needs. Returns the lesson, the record and git.
     */
    function repoWith(later: (write: (file: string, lines: string[], subject: string, day: number) => string, dir: string) => void) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-lines-'));
        const run = (args: string[], day?: number) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...(day !== undefined ? { GIT_AUTHOR_DATE: at(day), GIT_COMMITTER_DATE: at(day) } : {}) } }).trim();
        const at = (day: number) => new Date(Date.UTC(2026, 8, 1) + day * 86_400_000).toISOString();
        const write = (file: string, lines: string[], subject: string, day: number) => {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            fs.writeFileSync(path.join(dir, file), lines.join('\n') + '\n');
            run(['add', '-A']);
            run(['commit', '-qm', subject], day);
            return run(['rev-parse', 'HEAD']);
        };
        run(['init', '-q', '-b', 'main']);
        run(['config', 'user.email', 't@example.com']);
        run(['config', 'user.name', 't']);
        const base = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
        write('src/job.ts', base, 'init', -5);
        const reviewed = write('src/other.ts', ['x'], 'the pull request: another file', -1);
        const mergeSha = reviewed; // a fast-forward merge on day -1 stands in for the merge commit
        later(write, dir);
        const l = lesson([point(7)]);
        l.at = { commit: reviewed, start: 4, end: 5 };
        const log = run(['log', '--format=%x00%H%x09%cI%x09%s', '--name-only', `${mergeSha}..main`]);
        const followUps = log.split('\0').filter(Boolean).map(block => {
            const [header, ...files] = block.split('\n').map(line => line.trim()).filter(Boolean);
            const [sha, when, subject] = header.split('\t');
            return { sha, at: when, subject, files, fix: /fix/i.test(subject) };
        });
        const rec = record(7, { mergeSha, mergedAt: at(-1), windowEnd: at(29), followUps });
        return { dir, l, rec, git: gitIn(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    }
    const lines = (change: Record<number, string>) => Array.from({ length: 10 }, (_, i) => change[i + 1] ?? `line ${i + 1}`);

    it('records a later fix on the point\'s own lines as evidence for a person, with CI as context, and never promotes on it', () => {
        const r = repoWith(write => write('src/job.ts', lines({ 5: 'line 5 fixed' }), 'fix: take the lock first', 3));
        try {
            const result = applyOutcomeEvidence([r.l], [{ ...r.rec, ci: 'failure' }], none, { demoteAfter: 2, git: r.git, mainRef: 'main' });
            expect(r.l.state).toBe('candidate');
            expect(result).toMatchObject({ suggested: ['L1'], demoted: [] });
            expect(r.l.evidence.at(-1)).toMatchObject({ kind: 'lines', detail: expect.stringMatching(/^fixed later by \w{9} "fix: take the lock first"; CI regressed on the merge commit$/) });
            // Once: running again suggests nothing new.
            expect(applyOutcomeEvidence([r.l], [{ ...r.rec, ci: 'failure' }], none, { demoteAfter: 2, git: r.git, mainRef: 'main' }).suggested).toEqual([]);
        } finally { r.cleanup(); }
    });

    it('counts lines within three of the point, and never a fix elsewhere in the file, however CI went', () => {
        const near = repoWith(write => write('src/job.ts', lines({ 8: 'line 8 fixed' }), 'fix: three below', 3));
        const far = repoWith(write => write('src/job.ts', lines({ 10: 'line 10 fixed' }), 'fix: unrelated', 3));
        try {
            applyOutcomeEvidence([near.l], [near.rec], none, { demoteAfter: 2, git: near.git, mainRef: 'main' });
            applyOutcomeEvidence([far.l], [{ ...far.rec, ci: 'failure' }], none, { demoteAfter: 2, git: far.git, mainRef: 'main' });
            expect(near.l.evidence.at(-1)?.kind).toBe('lines');
            expect(far.l.state).toBe('candidate');
            expect(far.l.evidence.map(e => e.kind)).toEqual(['point', 'followup']);
        } finally { near.cleanup(); far.cleanup(); }
    });

    it('says nothing about the point when the fix on its lines is a sweep of more than fifteen files', () => {
        const r = repoWith((write, dir) => {
            // Sixteen other files in the same commit as the change to the point's lines.
            for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(dir, 'src', `m${i}.ts`), `export const m = ${i};\n`);
            write('src/job.ts', lines({ 4: 'line 4 swept' }), 'fix: launch readiness sweep', 2);
        });
        try {
            expect(r.rec.followUps[0].files).toHaveLength(17);
            applyOutcomeEvidence([r.l], [r.rec], none, { demoteAfter: 2, git: r.git, mainRef: 'main' });
            expect(r.l.state).toBe('candidate');
            expect(r.l.evidence.map(e => e.kind)).toEqual(['point', 'followup']);
        } finally { r.cleanup(); }
    });
});
