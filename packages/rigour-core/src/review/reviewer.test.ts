import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { parseVerdict, reviewerBlocks, runReviewer, type Exec } from './reviewer.js';

let repo: string;
const config = ConfigSchema.parse({ version: 1, review: { github_account: 'reviewer-account' } });
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

const REVIEWS = [
    { id: 1, user: { login: 'ci-bot', type: 'Bot' }, body: 'automated', state: 'COMMENTED', submitted_at: '2026-10-01' },
    { id: 2, user: { login: 'author', type: 'User' }, body: 'self note', state: 'COMMENTED', submitted_at: '2026-10-02' },
    { id: 3, user: { login: 'senior', type: 'User' }, body: 'Two blocking points.', state: 'CHANGES_REQUESTED', submitted_at: '2026-10-03' },
];
const INLINE = [{ path: 'src/job.ts', line: 12, body: 'Check the lock before the first read.' }];

/** Real git; scripted gh; a reviewer that records what it was shown and answers `answer`. */
function fakes(answer: string, seen: { prompts: string[]; review?: string; ghToken?: string }): Exec {
    return async (command, args, options) => {
        if (command === 'git') {
            try {
                return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' };
            } catch (error: any) {
                return { exitCode: 1, stdout: '', stderr: String(error.message) };
            }
        }
        if (command === 'gh') {
            if (args[0] === 'auth') return { exitCode: 0, stdout: 'token-for-account\n', stderr: '' };
            seen.ghToken = options.env?.GH_TOKEN;
            if (args[0] === 'pr') return { exitCode: 0, stdout: '42\tauthor\n', stderr: '' };
            if (args[1].endsWith('/reviews')) return { exitCode: 0, stdout: JSON.stringify(REVIEWS), stderr: '' };
            return { exitCode: 0, stdout: JSON.stringify(INLINE), stderr: '' };
        }
        const prompt = args[args.indexOf('-p') + 1];
        seen.prompts.push(prompt);
        seen.review = fs.readFileSync(prompt.match(/previous human review: (\S+)/)![1], 'utf8');
        return { exitCode: 0, stdout: JSON.stringify({ result: answer }), stderr: '' };
    };
}

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('the reviewer', () => {
    it("works from the latest person's review with its inline comments, and blocks on an open point", async () => {
        const seen = { prompts: [] as string[] } as { prompts: string[]; review?: string; ghToken?: string };
        const answer = JSON.stringify({ prior_points: [{ point: 'lock before read', resolved: false, evidence: 'src/job.ts:12' }], blocking: [], non_blocking: [] });
        const result = await runReviewer(repo, 'main', config, fakes(answer, seen));
        expect(seen.review).toContain('Reviewer: senior');
        expect(seen.review).toContain('- src/job.ts:12: Check the lock before the first read.');
        expect(seen.review).not.toContain('automated');
        expect(seen.review).not.toContain('self note');
        expect(seen.ghToken).toBe('token-for-account');
        expect(result).toMatchObject({ cached: false, previousReview: 'senior, 2026-10-03' });
        expect(reviewerBlocks(result)).toBe(true);
    });

    it('caches the verdict per commit and review, so the same push is free', async () => {
        const seen = { prompts: [] as string[] };
        const answer = JSON.stringify({ prior_points: [{ point: 'p', resolved: true }], blocking: [] });
        await runReviewer(repo, 'main', config, fakes(answer, seen));
        const again = await runReviewer(repo, 'main', config, fakes(answer, seen));
        expect(again.cached).toBe(true);
        expect(seen.prompts).toHaveLength(1);
        expect(reviewerBlocks(again)).toBe(false);
        expect(fs.readdirSync(repo)).toEqual(['.git', 'a.ts']); // nothing written to the working tree
    });

    it('never passes on an answer that is not a verdict', () => {
        expect(parseVerdict({ exitCode: 1, stdout: '', stderr: 'API error' }, false)).toMatchObject({ error: expect.stringContaining('did not answer') });
        expect(parseVerdict({ exitCode: 0, stdout: JSON.stringify({ result: 'Looks good to me!' }), stderr: '' }, false)).toMatchObject({ error: expect.stringContaining('not a verdict') });
        expect(parseVerdict({ exitCode: 0, stdout: JSON.stringify({ result: '{"prior_points":[],"blocking":[]}' }), stderr: '' }, true))
            .toEqual({ error: 'the reviewer did not report on the previous review' });
        expect(reviewerBlocks({ error: 'x', cached: false })).toBe(true);
    });
});
