import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { backgroundReview, reviewStatus, startBackgroundReview } from './background.js';
import type { Exec } from './exec.js';
import { VerdictStore } from './store.js';

let repo: string;
let bin: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const config = ConfigSchema.parse({ version: 1, review: { reviewer: { enabled: true } } });
const originalPath = process.env.PATH;

let PR = { number: 7, state: 'OPEN', isDraft: false, author: { login: 'author' }, body: 'desc' };
const VERDICT = JSON.stringify({ prior_points: [], redundant: [], reads: [], scans: [], merge_impact: [], findings: [{ class: 'correctness', file: 'src/job.ts', line: 1, issue: 'never locks', consequence: 'a second run reads stale rows' }], carried: [], resolved_previous: [] });

/** Real git; a pull request on the branch; a claude that answers one finding. */
const exec: Exec = async (command, args, options) => {
    if (command === 'git') {
        try {
            return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' };
        } catch (error: any) {
            return { exitCode: 1, stdout: '', stderr: String(error.message) };
        }
    }
    if (command === 'gh') {
        if (args[0] === 'pr') return { exitCode: 0, stdout: JSON.stringify(PR), stderr: '' };
        return { exitCode: 0, stdout: '[]', stderr: '' };
    }
    if (args[0] === '--version') return { exitCode: 0, stdout: '1.0.0\n', stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify({ result: VERDICT }), stderr: '' };
};

beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = [bin, originalPath ?? ''].join(path.delimiter);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'background-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'feature');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export const job = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'job');
});
afterEach(() => {
    process.env.PATH = originalPath;
    try { git('worktree', 'prune'); } catch { /* gone */ }
    for (const dir of [repo, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the background review', () => {
    it('reviews the pushed commit in a worktree of its own, records the verdict under the branch, and leaves the checkout alone', async () => {
        const head = git('rev-parse', 'HEAD');
        fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export const job = 2; // edited after the push\n'); // must not be what the reviewer reads
        const lines: string[] = [];
        const result = await backgroundReview(repo, { head, branch: 'feature', base: 'main' }, config, exec, line => lines.push(line));
        expect(result).toMatchObject({ outcome: 'findings', pr: 7 });
        expect(result.items).toEqual([expect.objectContaining({ file: 'src/job.ts', issue: 'never locks' })]);
        expect(lines.at(-1)).toContain('never locks');
        expect(fs.readFileSync(path.join(repo, 'src/job.ts'), 'utf8')).toContain('edited after the push');
        const store = (await VerdictStore.open(repo, exec))!;
        expect(store.branchState('feature')).toMatchObject({ head, mode: 'full' });
        expect(fs.existsSync(store.worktreeDir(head))).toBe(false); // removed when done
        const status = await reviewStatus(repo, 'feature', exec);
        expect(status).toMatchObject({ branch: 'feature', last: { head, mode: 'full', open: [expect.objectContaining({ issue: 'never locks' })] } });
        expect(status?.running).toBeUndefined();
    });

    it('asks whether a review is due before checking anything out, and the status says why it was skipped', async () => {
        PR = { ...PR, isDraft: true };
        try {
            const head = git('rev-parse', 'HEAD');
            const result = await backgroundReview(repo, { head, branch: 'feature', base: 'main' }, config, exec, () => undefined);
            expect(result).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('is a draft') });
            const store = (await VerdictStore.open(repo, exec))!;
            expect(fs.existsSync(store.worktreeDir(head))).toBe(false); // never checked out
            expect((await reviewStatus(repo, 'feature', exec))?.attempt).toMatchObject({ head, outcome: 'skipped', reason: expect.stringContaining('is a draft') });
        } finally {
            PR = { ...PR, isDraft: false };
        }
    });

    it('starts detached with a pid the status reports, and a newer start for the branch ends the older one', async () => {
        const head = git('rev-parse', 'HEAD');
        const sleeper = [process.execPath, '-e', 'setTimeout(() => {}, 20000)'];
        const log = await startBackgroundReview(repo, { head, branch: 'feature', base: 'main' }, sleeper, exec);
        expect(log).toMatch(/feature\.log$/);
        const first = (await reviewStatus(repo, 'feature', exec))?.running;
        expect(first).toMatchObject({ head });
        expect(alive(first!.pid)).toBe(true);
        await startBackgroundReview(repo, { head: 'b'.repeat(40), branch: 'feature', base: 'main' }, sleeper, exec);
        const second = (await reviewStatus(repo, 'feature', exec))?.running;
        expect(second?.pid).not.toBe(first!.pid);
        for (let waited = 0; alive(first!.pid) && waited < 3000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50)); // under load the signal lands later
        expect(alive(first!.pid)).toBe(false);
        process.kill(second!.pid);
    });
});

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
