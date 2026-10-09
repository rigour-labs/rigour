import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCompiledChecks } from '@rigour-labs/core';
import { learnReviewsCommand } from './learn-reviews.js';

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-reviews-cli-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'ana@example.com']);
    fs.mkdirSync(path.join(repo, '.rigour'));
    fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [{
        id: 'L1', text: 'Never call `fetchAll` in a request handler.', file: 'src/load.ts', symbols: ['fetchAll'], state: 'verified', createdAt: '', updatedAt: '',
        evidence: [{ kind: 'point', pr: 1, comment: 'p', author: 'r' }, { kind: 'accepted', pr: 1, comment: 'a', author: 'ana@example.com' }],
    }] }));
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('rigour learn-reviews --compile', () => {
    it('proposes a check, runs it only once a person approves it, and records who took it back', async () => {
        const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await learnReviewsCommand(repo, { compile: true });
        expect(out.mock.calls.flat().join('\n')).toContain('proposed');
        expect(out.mock.calls.flat().join('\n')).toContain('--approve-check <id>');
        await learnReviewsCommand(repo, { approveCheck: 'c-L1' });
        expect(readCompiledChecks(repo)[0]).toMatchObject({ state: 'active', by: 'ana@example.com' });
        await learnReviewsCommand(repo, { withdrawCheck: 'c-L1' });
        expect(readCompiledChecks(repo)[0]).toMatchObject({ state: 'withdrawn' });
    });

    it('refuses a decision when no git email names who made it', async () => {
        execFileSync('git', ['-C', repo, 'config', 'user.email', '']);
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await learnReviewsCommand(repo, { compile: true });
        await learnReviewsCommand(repo, { approveCheck: 'c-L1' });
        expect(err.mock.calls.flat().join('\n')).toContain('No git email is set');
        expect(readCompiledChecks(repo)[0].state).toBe('proposed');
        process.exitCode = 0;
    });
});
