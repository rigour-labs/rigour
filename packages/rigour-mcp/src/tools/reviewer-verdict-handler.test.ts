import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewStatus = vi.fn();
vi.mock('@rigour-labs/core', async original => ({ ...(await original<typeof import('@rigour-labs/core')>()), reviewStatus }));
const { handleReviewerVerdict } = await import('./reviewer-verdict-handler.js');

let repo: string;
let head: string;
const answer = async () => JSON.parse((await handleReviewerVerdict(repo)).content[0].text);
const LOCK = { id: 'abcdef0123', kind: 'finding', class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', consequence: 'two runs send the same email', reviewer: 'claude+codex' };

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-verdict-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    head = git('rev-parse', 'HEAD');
    reviewStatus.mockReset();
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('rigour_reviewer_verdict', () => {
    it('says there is no verdict yet, and how one is made', async () => {
        reviewStatus.mockResolvedValue({ branch: 'feature' });
        expect(await answer()).toMatchObject({ branch: 'feature', verdict: null, next: expect.stringContaining('rigour review --reviewer') });
    });

    it('lists the confirmed items as the work and the disputed ones as not work', async () => {
        reviewStatus.mockResolvedValue({ branch: 'feature', last: { head, mode: 'full', at: 'now', open: [LOCK], disputed: [{ ...LOCK, id: 'ffff000011', issue: 'maybe slow' }], ran: { asked: 'panel', ran: 'panel', source: 'team' } } });
        const result = await answer();
        expect(result.verdict).toMatchObject({ current: true, ran: { ran: 'panel' }, fix: [{ id: 'abcdef0123', issue: 'returns before the lock', consequence: 'two runs send the same email', judges: 'claude+codex' }], disputed_not_work: [{ issue: 'maybe slow' }] });
        expect(result.next).toContain('only they can dismiss it');
    });

    it('warns when the verdict is for an earlier commit', async () => {
        reviewStatus.mockResolvedValue({ branch: 'feature', last: { head: '0'.repeat(40), mode: 'delta', at: 'then', open: [LOCK], disputed: [] } });
        const result = await answer();
        expect(result.verdict.current).toBe(false);
        expect(result.next).toContain('for an earlier commit');
    });

    it('says why there is no verdict when the last review could not run', async () => {
        reviewStatus.mockResolvedValue({ branch: 'feature', attempt: { head, outcome: 'unavailable', reason: 'rigour.yml requires two reviewers from different vendors', at: 'now' } });
        const result = await answer();
        expect(result.last_attempt).toMatchObject({ outcome: 'unavailable' });
        expect(result.next).toContain('could not run: rigour.yml requires two reviewers');
    });
});

