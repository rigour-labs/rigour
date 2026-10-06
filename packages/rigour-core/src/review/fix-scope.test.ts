import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixScope as scopeWith } from './fix-scope.js';
import type { Exec } from './reviewer/exec.js';

let repo: string;
let reviewed: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const commit = (message: string) => {
    git('add', '-A');
    git('commit', '-qm', message);
};

const PR = { number: 42, state: 'OPEN', isDraft: false, author: { login: 'author' }, body: '' };
const user = (login: string, type = 'User') => ({ login, type });
let reviews: unknown[];
let comments: unknown[];

/** Real git; gh answers from `reviews` and `comments`. */
const exec: Exec = async (command, args, options) => {
    if (command === 'git') {
        try {
            return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
        } catch (error: any) {
            return { exitCode: 1, stdout: '', stderr: String(error.message) };
        }
    }
    if (args[0] === 'pr') return { exitCode: 0, stdout: JSON.stringify(PR), stderr: '' };
    if (args[1]?.endsWith('/reviews')) return { exitCode: 0, stdout: JSON.stringify(reviews), stderr: '' };
    if (args[1]?.endsWith('/comments')) return { exitCode: 0, stdout: JSON.stringify(comments), stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'unexpected gh call' };
};

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-scope-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    for (const file of ['src/job.ts', 'src/job.test.ts', 'src/util.ts', 'src/deep/thing.ts', 'src/other.ts', 'src/temp.ts', 'src/mainside.ts', 'lib/util.ts']) write(file, 'export const x = 1;\n');
    commit('base');
    git('checkout', '-qb', 'feature');
    write('src/job.ts', 'export const x = 2;\n');
    commit('the change under review');
    reviewed = git('rev-parse', 'HEAD');
    reviews = [
        { id: 1, user: user('ci-bot', 'Bot'), body: 'see src/other.ts', submitted_at: '2026-10-01', commit_id: reviewed },
        { id: 2, user: user('author'), body: 'I will also tidy src/other.ts', submitted_at: '2026-10-02', commit_id: reviewed },
        { id: 3, user: user('senior'), body: 'Bound the window in `src/util.ts:4`. The scan in https://github.com/o/r/blob/abc123/src/deep/thing.ts#L3 is quadratic.', submitted_at: '2026-10-03', commit_id: reviewed },
        { id: 4, user: user('second'), body: '', submitted_at: '2026-10-03', commit_id: reviewed },
    ];
    comments = [
        { id: 9, pull_request_review_id: 4, user: user('second'), path: 'src/job.ts', body: 'Lock before the first read.' },
        { id: 10, pull_request_review_id: 2, user: user('author'), path: 'src/temp.ts', body: 'my own note' },
    ];
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const fixScope = (cwd: string, named: { review?: number }, run: Exec) => scopeWith(cwd, { pr: undefined, review: named.review, githubAccount: undefined }, run);

describe('the scope of a fix round', () => {
    it('lists the files the round changed that no point of the review cited', async () => {
        for (const file of ['src/job.ts', 'src/job.test.ts', 'src/util.ts', 'src/deep/thing.ts', 'src/other.ts']) write(file, 'export const x = 3;\n');
        commit('fix round');
        write('src/temp.ts', 'export const x = 9;\n');
        commit('try something');
        write('src/temp.ts', 'export const x = 1;\n');
        commit('put it back');
        git('checkout', '-q', 'main');
        write('src/mainside.ts', 'export const x = 4;\n');
        commit('main moves on');
        git('checkout', '-q', 'feature');
        git('merge', '-q', '--no-edit', 'main');

        const { scope, error } = await fixScope(repo, {}, exec);
        expect(error).toBeUndefined();
        expect(scope).toMatchObject({ pr: 42, review: { id: 4, login: 'second', commit: reviewed } });
        expect(scope!.cited).toEqual(['src/deep/thing.ts', 'src/job.ts', 'src/util.ts']);
        expect(scope!.changed).toEqual(['src/deep/thing.ts', 'src/job.test.ts', 'src/job.ts', 'src/other.ts', 'src/util.ts']);
        expect(scope!.extra).toEqual(['src/other.ts']);
    });

    it('takes a named review as the round, and an ambiguous file name cites nothing', async () => {
        write('src/job.ts', 'export const x = 3;\n');
        commit('first fix round');
        reviews.push({ id: 5, user: user('senior'), body: 'and util.ts too', submitted_at: '2026-10-04', commit_id: git('rev-parse', 'HEAD') });
        write('src/util.ts', 'export const x = 3;\n');
        commit('second fix round');
        const named = await fixScope(repo, { review: 5 }, exec);
        expect(named.scope!.cited).toEqual([]);
        expect(named.scope!.extra).toEqual(['src/util.ts']);
    });

    it('says why it cannot answer', async () => {
        expect((await fixScope(repo, { review: 99 }, exec)).error).toBe('no review 99 by a person on pull request 42');
        reviews = reviews.filter((r: any) => r.user.type === 'Bot');
        expect((await fixScope(repo, {}, exec)).error).toBe('pull request 42 has no review by a person yet');
        reviews = [{ id: 3, user: user('senior'), body: 'x', submitted_at: '2026-10-03', commit_id: 'f'.repeat(40) }];
        expect((await fixScope(repo, {}, exec)).error).toMatch(/^the reviewed commit fffffffff is not behind HEAD/);
    });
});
