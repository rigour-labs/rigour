import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '@rigour-labs/core';
import { whatWasChecked } from './review-checked.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const result = { report: { summary: { 'hallucinated-imports': 'PASS', 'unused-exports': 'FAIL' } } } as unknown as ReviewResult;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'checked-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('what a review checked', () => {
    it('names the commits compared, whether uncommitted work was in it, the settings and every check', () => {
        const base = git('rev-parse', 'HEAD');
        git('checkout', '-q', '-b', 'feature');
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
        git('commit', '-qam', 'change');
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 3;\n'); // not committed

        expect(whatWasChecked(repo, { base: 'main' }, undefined, result)).toMatchObject({
            rigour_version: expect.stringMatching(/^\d+\.\d+\.\d+/),
            base: 'main',
            base_sha: base,
            head_sha: git('rev-parse', 'HEAD'),
            uncommitted: true,
            config: 'defaults',
            checks: { 'hallucinated-imports': 'PASS', 'unused-exports': 'FAIL' },
        });
    });

    it('says which rigour.yml it read: the working tree, the base for an independent review, or a file named by -c', () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'gates: {}\n');
        expect(whatWasChecked(repo, {}, undefined, result)).toMatchObject({ base: null, base_sha: git('rev-parse', 'HEAD'), uncommitted: false, config: 'rigour.yml' });

        const base = git('rev-parse', 'HEAD'); // rigour.yml is not committed there
        expect(whatWasChecked(repo, { base: 'main' }, base, result).config).toBe('defaults');
        git('add', '-A');
        git('commit', '-qm', 'config');
        expect(whatWasChecked(repo, { base: 'main' }, git('rev-parse', 'HEAD'), result).config).toBe(`rigour.yml at ${git('rev-parse', 'HEAD')}`);

        fs.mkdirSync(path.join(repo, 'ci'));
        fs.writeFileSync(path.join(repo, 'ci/strict.yml'), 'gates: {}\n');
        expect(whatWasChecked(repo, { config: 'ci/strict.yml' }, undefined, result).config).toBe('ci/strict.yml');
    });
});
