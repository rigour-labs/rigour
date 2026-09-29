/**
 * The trees before and after a fix commit, extracted with `git archive` into
 * a temporary folder. Read-only against the repository: no checkout, no
 * worktree, no change to its index or refs.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface FixTrees {
    commit: string;
    beforeDir: string;
    afterDir: string;
    files: string[];
    dispose(): void;
}

export function extractFixTrees(repoDir: string, rev: string): FixTrees {
    const git = (...args: string[]) => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
    const commit = git('rev-parse', '--verify', `${rev}^{commit}`);
    const parent = git('rev-parse', '--verify', `${commit}^`);
    const files = git('diff', '--name-only', '--diff-filter=M', parent, commit).split('\n').filter(Boolean);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-learn-'));
    const unpack = (sha: string, name: string): string => {
        const dir = path.join(root, name);
        const archive = path.join(root, `${name}.tar`);
        fs.mkdirSync(dir);
        git('archive', '--format=tar', '-o', archive, sha);
        execFileSync('tar', ['-xf', archive, '-C', dir]);
        fs.rmSync(archive);
        return dir;
    };
    return {
        commit,
        beforeDir: unpack(parent, 'before'),
        afterDir: unpack(commit, 'after'),
        files,
        dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}
