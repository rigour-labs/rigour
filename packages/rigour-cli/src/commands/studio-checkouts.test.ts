import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutRoots } from './studio-checkouts.js';

let repo: string;
beforeEach(() => {
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'checkouts-')));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    fs.mkdirSync(path.join(repo, '.rigour'));
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('checkoutRoots', () => {
    it('lists each checkout once, however the folder is spelled', () => {
        const tree = path.join(repo, 'wt');
        execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', tree]);
        fs.mkdirSync(path.join(tree, '.rigour'));
        // git reports these folders with forward slashes; started from a trailing-slash path
        expect(checkoutRoots(repo + path.sep)).toEqual([repo, fs.realpathSync.native(tree)]);
    });
});
