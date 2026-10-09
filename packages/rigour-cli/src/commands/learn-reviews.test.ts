import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCompiledChecks, readLessons } from '@rigour-labs/core';
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

describe('rigour learn-reviews --use-wording', () => {
    it('lists a corrected wording beside a decided lesson, and takes it only on a person\'s word', async () => {
        const file = path.join(repo, '.rigour', 'review-lessons.json');
        const store = JSON.parse(fs.readFileSync(file, 'utf8'));
        store.lessons[0] = { ...store.lessons[0], suggestedText: 'Never call `fetchAll` in a request handler. Page it with a keyset.', suggestedWhy: 'parser fix' };
        fs.writeFileSync(file, JSON.stringify(store));
        const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await learnReviewsCommand(repo, { list: true });
        const listed = out.mock.calls.flat().join('\n');
        expect(listed).toContain('corrected wording (parser fix): Never call `fetchAll` in a request handler. Page it with a keyset.');
        expect(listed).toContain('rigour learn-reviews --use-wording L1');
        await learnReviewsCommand(repo, { useWording: 'L1' });
        expect(readLessons(repo)[0]).toMatchObject({ text: 'Never call `fetchAll` in a request handler. Page it with a keyset.', state: 'verified' });
        expect(readLessons(repo)[0].evidence.at(-1)).toMatchObject({ kind: 'reworded', author: 'ana@example.com' });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await learnReviewsCommand(repo, { useWording: 'L1' });
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
    });
});
