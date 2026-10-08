import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitPushGateCommand, installGitPushHook, selfTestCommand, selfTestGitPushHook } from './hooks-git.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/bin.js');

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '.git/hooks'); // a machine-wide hooks path must not reach the test
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\ngates:\n  unused_exports:\n    block: true\n'); // this team blocks on dead code
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('the git pre-push hook', () => {
    it('is installed where git looks, once, and completes a hook another tool owns instead of replacing it', () => {
        const first = installGitPushHook(repo, 'npx --yes @rigour-labs/cli@9.9.9');
        expect(first.action).toBe('installed');
        const text = fs.readFileSync(first.path, 'utf8');
        expect(text).toContain('exec npx --yes @rigour-labs/cli@9.9.9 hooks push --git "$@"');
        if (process.platform !== 'win32') expect(fs.statSync(first.path).mode & 0o111).toBeTruthy(); // no execute bit on Windows
        expect(installGitPushHook(repo, 'npx --yes @rigour-labs/cli@9.9.9').action).toBe('present');

        git('config', 'core.hooksPath', '.husky');
        fs.mkdirSync(path.join(repo, '.husky'));
        fs.writeFileSync(path.join(repo, '.husky/pre-push'), '#!/bin/sh\nnpm test\n');
        const appended = installGitPushHook(repo, 'rigour');
        expect(appended).toMatchObject({ action: 'appended', path: path.join(repo, '.husky/pre-push') });
        expect(fs.readFileSync(appended.path, 'utf8')).toBe('#!/bin/sh\nnpm test\n\n# Rigour push gate (rigour hooks init): the same gate for every tool and the terminal.\nrigour hooks push --git "$@" || exit $?\n');
        expect(installGitPushHook(repo, 'rigour').action).toBe('present');
        expect(installGitPushHook(path.join(os.tmpdir()), 'rigour').action).toBe('no repository');

        // A hooks directory outside the repository belongs to whoever set it: named, never written.
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'global-hooks-'));
        fs.writeFileSync(path.join(elsewhere, 'pre-push'), '#!/bin/sh\nexit 0\n');
        git('config', 'core.hooksPath', elsewhere);
        expect(installGitPushHook(repo, 'rigour')).toEqual({ path: path.join(elsewhere, 'pre-push'), action: 'managed elsewhere' });
        expect(fs.readFileSync(path.join(elsewhere, 'pre-push'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
        fs.rmSync(elsewhere, { recursive: true, force: true });
    });

    it('refuses a push from a tree with uncommitted changes to tracked files, and lets a branch deletion through', async () => {
        const refs = `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main 0000000000000000000000000000000000000000\n`;
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
        const dirty = await gitPushGateCommand(refs, repo);
        expect(dirty.exitCode).toBe(1);
        expect(dirty.message).toContain('uncommitted changes to tracked files');
        expect(dirty.message).toContain(' M a.ts');
        const deletion = await gitPushGateCommand('(delete) 0000000000000000000000000000000000000000 refs/heads/old 1234567890123456789012345678901234567890\n', repo);
        expect(deletion).toEqual({ exitCode: 0, message: '' });
    });

    it('holds under a real git push: a change the gate must refuse is refused, the fix lands, read from the remote', async () => {
        const result = await selfTestGitPushHook(selfTestCommand(bin));
        expect(result.steps.join('\n')).toContain('was refused');
        expect(result).toMatchObject({ ok: true });
    }, 120_000);
});
