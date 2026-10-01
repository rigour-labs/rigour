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
        const config = ConfigSchema.parse({ version: 1 });
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
});
