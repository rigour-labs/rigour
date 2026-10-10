import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateRunner } from '../gates/runner.js';
import { ConfigSchema, type Failure } from '../types/index.js';
import { parseDiff } from '../utils/diff.js';
import { splitByChangedLines } from './changed-lines.js';
import { anchorInChangedFunction, changedFunctionSpans } from './changed-function-spans.js';
import { diffFromGit } from './git-diff.js';
import { reviewChange, toReviewFinding } from './review.js';
import { findingKey } from './quiet.js';

/** These tests are about other checks; a new unreferenced fixture file is not their subject. */
const NO_DEAD_CODE = { unused_exports: { enabled: false }, orphan_files: { enabled: false } };

const LEAKY = [
    'export async function notify(endpoint: string, signature: string) {',
    "  return fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } });",
    '}',
    '',
].join('\n');

function failure(file: string | undefined, line?: number): Failure {
    return { id: 'x', title: 'X', details: 'd', files: file ? [file] : [], ...(line !== undefined ? { line } : {}) } as Failure;
}

describe('splitByChangedLines', () => {
    it('separates changed-line, file-level, unlocated and outside findings', () => {
        const changed = { 'a.ts': new Set([3]) };
        const split = splitByChangedLines([failure('a.ts', 3), failure('a.ts', 9), failure('a.ts'), failure('b.ts'), failure(undefined)], changed);
        expect(split.findings.map(f => f.line)).toEqual([3]);
        expect(split.fileFindings).toHaveLength(1);
        expect(split.unlocated).toBe(1);
        expect(split.outside).toBe(2);
    });

    it('keeps a deep finding inside a changed function, anchored on the nearest changed line', () => {
        const deep = (line: number) => ({ ...failure('a.ts', line), provenance: 'deep-analysis' }) as Failure;
        const changed = { 'a.ts': new Set([12, 14]) };
        const spans = { 'a.ts': [[10, 20]] as Array<[number, number]> };
        const split = splitByChangedLines([deep(11), deep(30), failure('a.ts', 11)], changed, spans);
        expect(split.findings).toEqual([expect.objectContaining({ line: 11, anchorLine: 12 })]);
        expect(split.contextFindings.map(f => f.line)).toEqual([30]); // elsewhere in a changed file: shown, not blocking
        expect(split.outside).toBe(1); // a rule finding on an unchanged line is pre-existing, as before
    });

    it('counts a multi-line finding as changed when lines inside it were deleted', () => {
        // fetch(url, {      <- line 4, unchanged
        //   redirect: ...   <- deleted, so the removal sits before new line 5
        // })                <- line 5
        const call = { ...failure('a.ts', 4), endLine: 5 } as Failure;
        const outsideCall = { ...failure('a.ts', 9), endLine: 10 } as Failure;
        const removed = { 'a.ts': [{ line: 5, text: ["  redirect: 'manual',"] }] };
        const split = splitByChangedLines([call, outsideCall, failure('a.ts', 4)], {}, {}, removed);
        expect(split.findings).toEqual([call]);
        expect(split.outside).toBe(2);
    });
});

describe('changedFunctionSpans', () => {
    it('spans the outermost function around changed lines, and anchors to the nearest changed line in it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spans-'));
        try {
            fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1;\nexport function f(a: number) {\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}\n');
            const spans = changedFunctionSpans(dir, { 'a.ts': new Set([4]), 'missing.ts': new Set([1]), 'notes.md': new Set([1]) });
            expect(spans).toEqual({ 'a.ts': [[2, 7]] });
            expect(anchorInChangedFunction(6, new Set([4]), spans['a.ts'])).toBe(4);
            expect(anchorInChangedFunction(1, new Set([4]), spans['a.ts'])).toBeUndefined();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('git-backed review', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-core-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('works in a repository with no commits yet', () => {
        write('src/new.ts', 'export const a = 1;\n');
        expect(parseDiff(diffFromGit(repo))).toEqual({ 'src/new.ts': new Set([1]) });
    });

    it('takes uncommitted edits and untracked files from the working tree', () => {
        write('src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/a.ts', 'export const a = 1;\nexport const b = 3;\n');
        write('src/new.ts', 'export const c = 1;\nexport const d = 2;\n');
        expect(parseDiff(diffFromGit(repo))).toEqual({ 'src/a.ts': new Set([2]), 'src/new.ts': new Set([1, 2]) });
    });

    it('takes a branch against its merge-base, committed and uncommitted', () => {
        write('src/a.ts', 'export const a = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        git('checkout', '-q', '-b', 'feature');
        write('src/b.ts', 'export const b = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'feature');
        write('src/a.ts', 'export const a = 1;\nexport const z = 2;\n');
        expect(parseDiff(diffFromGit(repo, { mode: 'base', base: 'main' }))).toEqual({ 'src/a.ts': new Set([2]), 'src/b.ts': new Set([1]) });
    });

    it('fails a change that introduces a bug and ignores the same bug in untouched code', async () => {
        write('src/old.ts', LEAKY);
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/notify.ts', LEAKY);
        const config = ConfigSchema.parse({ version: 1, gates: { semantic_bugs: { enabled: true } } });

        const result = await reviewChange({ cwd: repo, config });

        const semantic = result.findings.filter(f => f.id === 'semantic-bugs');
        expect(result.status).toBe('FAIL');
        expect(semantic.map(f => [f.files?.[0], f.line])).toEqual([['src/notify.ts', 2]]);
        expect(toReviewFinding(semantic[0])).toMatchObject({ id: 'semantic-bugs', file: 'src/notify.ts', line: 2, severity: 'high' });
    });

    it('finds the same in a diff of committed work as in --base: HEAD already holds the change, so it is no base to drop findings against', async () => {
        write('src/old.ts', 'export const ok = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        git('checkout', '-q', '-b', 'feature');
        write('src/notify.ts', LEAKY);
        git('add', '-A');
        git('commit', '-qm', 'feature');
        const config = ConfigSchema.parse({ version: 1, gates: { semantic_bugs: { enabled: true } } });
        const ids = (r: Awaited<ReturnType<typeof reviewChange>>) => r.findings.map(f => [f.id, f.files?.[0], f.line]);

        const base = await reviewChange({ cwd: repo, config, source: { mode: 'base', base: 'main' } });
        const file = await reviewChange({ cwd: repo, config, diff: git('diff', 'main...HEAD'), source: { mode: 'working' } });

        expect(base.status).toBe('FAIL');
        expect(file.status).toBe('FAIL');
        expect(ids(file)).toEqual(ids(base));
        expect(file.baseUnknown).toBe(true);
        // Uncommitted work piped in is still compared with HEAD, which does not hold it.
        write('src/more.ts', LEAKY);
        git('add', '-N', 'src/more.ts');
        expect((await reviewChange({ cwd: repo, config, diff: git('diff'), source: { mode: 'working' } })).baseUnknown).toBeUndefined();
    });

    it('tells the deep review what the compiled checks found and which lessons they covered, only where they ran', async () => {
        write('src/load.ts', 'export const ok = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        fs.mkdirSync(path.join(repo, '.rigour'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [{ id: 'L1', text: 'Never call `fetchAll` here.', file: 'src/load.ts', symbols: ['fetchAll'], state: 'verified', createdAt: '', updatedAt: '', evidence: [{ kind: 'point', pr: 1, comment: 'p', author: 'r' }, { kind: 'accepted', pr: 1, comment: 'a', author: 'lead' }] }] }));
        fs.writeFileSync(path.join(repo, '.rigour', 'compiled-checks.json'), JSON.stringify({ version: 1, checks: [{ id: 'c-L1', lessonId: 'L1', files: 'src/load.ts', kind: 'forbid', symbol: 'fetchAll', message: 'Never call `fetchAll` here.', state: 'active', at: '' }] }));
        const seenDeep: Array<{ settled?: unknown[]; covered?: unknown[] } | undefined> = [];
        vi.spyOn(GateRunner.prototype, 'run').mockImplementation(async (_cwd, _targets, deep) => {
            seenDeep.push(deep as never);
            return { status: 'PASS', summary: {}, failures: [], stats: { duration_ms: 0 } } as never;
        });
        const deep = { enabled: true } as never;
        write('src/load.ts', 'export const ok = 1;\nconst rows = fetchAll(db);\n');
        const touched = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1 }), deep });
        expect(touched.covered).toEqual([{ checkId: 'c-L1', lessonId: 'L1', message: 'Never call `fetchAll` here.' }]);
        expect(seenDeep[0]).toMatchObject({ settled: [{ file: 'src/load.ts', line: 2, kind: 'compiled-lesson' }], covered: [{ lessonId: 'L1' }] });
        // A change that does not touch the check's files: it did not run, so nothing is covered.
        git('checkout', '--', 'src/load.ts');
        write('src/other.ts', 'export const other = 1;\n');
        const elsewhere = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1 }), deep });
        expect(elsewhere.covered).toEqual([]);
        expect(seenDeep[1]).toMatchObject({ settled: [], covered: [] });
        vi.restoreAllMocks();
    });

    it("names every check it ran in the summary, the review's own beside the gates", async () => {
        write('src/a.ts', 'export const a = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/b.ts', 'export const unused = 2;\n');
        git('add', '-A');
        const config = ConfigSchema.parse({ gates: { migration_order: { enabled: false } } });

        const { report } = await reviewChange({ cwd: repo, config });

        expect(report?.summary).toMatchObject({ 'unused-exports': 'FAIL', 'migration-order': 'SKIP', 'query-patterns': 'PASS', 'change-sweep': 'PASS' });
        expect(report?.summary).not.toHaveProperty('redundancy'); // typed checks were not asked for
    });

    it('reports what the change introduced, not what the touched code already had', async () => {
        const branchy = (name: string, extra = '') => [
            `export function ${name}(x: number) {`,
            ...Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return ${i};`),
            extra,
            '  return -1;',
            '}',
            '',
        ].join('\n');
        write('src/old.ts', branchy('legacy'));
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/old.ts', branchy('legacy', '  if (x === 99) return 99;'));
        write('src/fresh.ts', branchy('fresh'));
        const config = ConfigSchema.parse({ version: 1 });

        const result = await reviewChange({ cwd: repo, config });
        const complexity = [...result.findings, ...result.fileFindings, ...result.advisory].filter(f => f.id === 'AST_COMPLEXITY');
        expect(complexity.map(f => f.files?.[0])).toEqual(['src/fresh.ts']);
        expect(result.preexisting).toBeGreaterThanOrEqual(1);

        const all = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1, review: { show_preexisting: true } }) });
        const shown = [...all.findings, ...all.fileFindings, ...all.advisory].filter(f => f.id === 'AST_COMPLEXITY');
        expect(shown.map(f => f.files?.[0]).sort()).toEqual(['src/fresh.ts', 'src/old.ts']);
        expect(all.preexisting).toBe(0);
    }, 30_000); // two whole reviews, each running the rules on the change and on the base tree

    it('passes a check whose findings were all already in the base, counting them, and fails one the change gave a finding', async () => {
        const branchy = (name: string, extra = '') => [
            `export function ${name}(x: number) {`,
            ...Array.from({ length: 12 }, (_, i) => `  if (x === ${i}) return ${i};`),
            extra,
            '  return -1;',
            '}',
            '',
        ].join('\n');
        write('src/old.ts', branchy('legacy'));
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/old.ts', branchy('legacy', '  if (x === 99) return 99;'));
        const config = ConfigSchema.parse({ version: 1 });

        const only = await reviewChange({ cwd: repo, config });
        // The complexity finding (id AST_COMPLEXITY) is counted under the gate that gave it.
        const gate = 'ast-analysis';
        expect(only.preexistingByCheck[gate]).toBeGreaterThanOrEqual(1);
        expect(only.report?.summary[gate]).toBe('PASS');

        write('src/fresh.ts', branchy('fresh'));
        const introduced = await reviewChange({ cwd: repo, config });
        expect(introduced.preexistingByCheck[gate]).toBeGreaterThanOrEqual(1);
        expect(introduced.report?.summary[gate]).toBe('FAIL');
    }, 30_000); // two whole reviews, each running the rules on the change and on the base tree

    it('lets a change dismiss its own finding only when the review trusts the working tree', async () => {
        write('src/old.ts', 'export const a = 1;\n');
        write('.gitignore', '.rigour/*\n!.rigour/dismissed.json\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        git('checkout', '-q', '-b', 'pr');
        write('src/notify.ts', LEAKY);
        const config = ConfigSchema.parse({ version: 1, gates: { semantic_bugs: { enabled: true }, ...NO_DEAD_CODE } });
        const key = findingKey((await reviewChange({ cwd: repo, config })).findings[0]);
        write('.rigour/dismissed.json', JSON.stringify({ version: 1, entries: [{ key, reason: 'trust me', at: 'now' }] }));
        git('add', '-A');
        git('commit', '-qm', 'pr');

        const trusting = await reviewChange({ cwd: repo, config, source: { mode: 'base', base: 'main' } });
        expect([trusting.status, trusting.dismissed]).toEqual(['PASS', 1]);
        expect(trusting.controlFilesChanged).toEqual(['.rigour/dismissed.json']);

        const independent = await reviewChange({ cwd: repo, config, source: { mode: 'base', base: 'main' }, trustedRef: 'main' });
        expect([independent.status, independent.dismissed]).toEqual(['FAIL', 0]);
    });

    it('runs every gate in a git worktree, where .git is a file', async () => {
        write('src/a.ts', 'export const a = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        const worktree = path.join(repo, 'wt');
        git('worktree', 'add', '-q', worktree);
        fs.writeFileSync(path.join(worktree, 'src/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
        const config = ConfigSchema.parse({ version: 1, ignore: ['.git/**', 'wt/**'] });

        const result = await reviewChange({ cwd: worktree, config });

        expect(result.gateErrors).toEqual([]);
        expect(result.status).not.toBe('ERROR');
    });

    it('is ERROR when a proven gate crashed, and only lists a crashed heuristic gate', async () => {
        write('src/a.ts', 'export const a = 1;\n');
        const config = ConfigSchema.parse({ version: 1, gates: NO_DEAD_CODE });
        const crash = (summary: Record<string, 'ERROR' | 'PASS'>) =>
            vi.spyOn(GateRunner.prototype, 'run').mockResolvedValueOnce({ status: 'FAIL', summary, failures: [], stats: { duration_ms: 0 } } as any);

        crash({ 'hallucinated-imports': 'ERROR' });
        const proven = await reviewChange({ cwd: repo, config });
        expect([proven.status, proven.gateErrors]).toEqual(['ERROR', ['hallucinated-imports']]);

        crash({ 'style-drift': 'ERROR', 'semantic-bugs': 'PASS' });
        const heuristic = await reviewChange({ cwd: repo, config });
        expect([heuristic.status, heuristic.gateErrors]).toEqual(['PASS', ['style-drift']]);
    });

    it('passes when nothing changed', async () => {
        write('src/a.ts', 'export const a = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        const result = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1 }) });
        expect(result).toMatchObject({ status: 'PASS', findings: [], report: null });
    });
    it('blocks a change that leaves the goal its description declares, and says nothing without a description', async () => {
        write('src/a.ts', 'export const a = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        write('src/a.ts', 'export const a = 2;\n');
        write('lib/other.ts', 'export const b = 1;\n');
        git('add', '-A');
        const config = ConfigSchema.parse({ version: 1, gates: NO_DEAD_CODE });
        const description = 'Changes a.\n\n## Scope\n- `src/`\n\n## Done when\n- `renameA` is called';

        const result = await reviewChange({ cwd: repo, config, goalDescription: description });

        expect(result.status).toBe('FAIL');
        expect(result.findings.map(f => [f.id, f.files?.[0]])).toEqual([['goal-scope', 'lib/other.ts']]);
        expect(result.advisory.filter(f => f.id === 'goal-done-when')).toHaveLength(1); // a named symbol is a note, never a block
        expect(result.report?.summary.goal).toBe('FAIL');
        expect(result.goal?.scope).toEqual(['src/']);
        // A bare name is a file only when the repository has it: `src/a.ts` exists as `a.ts`, `res.json` does not.
        const named = await reviewChange({ cwd: repo, config, goalDescription: '## Done when\n- `a.ts` changed\n- `res.json` returns the body' });
        expect(named.findings.filter(f => f.id === 'goal-done-when')).toEqual([]);
        expect(named.advisory.filter(f => f.id === 'goal-done-when').map(f => f.title)).toEqual([expect.stringContaining('`res.json`')]);
        const without = await reviewChange({ cwd: repo, config });
        expect(without.findings.filter(f => f.id.startsWith('goal-'))).toEqual([]);
        expect(without.report?.summary).not.toHaveProperty('goal');
        expect(without.goal).toBeUndefined();
    }, 30_000); // three whole reviews, each running the rules on the change
});
