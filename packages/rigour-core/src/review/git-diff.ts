/**
 * The diff to review, taken from git so callers do not have to build one.
 *
 * - working: uncommitted changes against HEAD, staged or not, plus new files
 *   git does not track yet (what an agent has just written).
 * - base: everything on this branch since it left `base` (the merge-base),
 *   including uncommitted changes (what a pull request contains).
 * - since: everything after `commit`, committed or not, plus untracked files
 *   (what an agent session wrote, even if it committed along the way).
 */
import { spawnSync } from 'child_process';

export type DiffSource = { mode: 'working' } | { mode: 'base'; base: string } | { mode: 'since'; commit: string };

export class GitDiffError extends Error {}

export function diffFromGit(cwd: string, source: DiffSource = { mode: 'working' }): string {
    if (source.mode === 'base') {
        const mergeBase = git(cwd, ['merge-base', source.base, 'HEAD']).trim();
        return git(cwd, ['diff', '--no-color', '--no-ext-diff', mergeBase]);
    }
    if (source.mode === 'since') {
        return git(cwd, ['diff', '--no-color', '--no-ext-diff', source.commit]) + untrackedFiles(cwd).map(file => newFileDiff(cwd, file)).join('');
    }
    const tracked = hasHead(cwd) ? git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD']) : '';
    return tracked + untrackedFiles(cwd).map(file => newFileDiff(cwd, file)).join('');
}

function untrackedFiles(cwd: string): string[] {
    return git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
}

/** `git diff --no-index` exits 1 when the files differ, which for a new file is always. */
function newFileDiff(cwd: string, file: string): string {
    const result = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', file], {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0 && result.status !== 1) throw new GitDiffError(`git diff for new file ${file} failed: ${result.stderr.trim()}`);
    return result.stdout;
}

function hasHead(cwd: string): boolean {
    return spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd }).status === 0;
}

function git(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw new GitDiffError(`git is not available: ${result.error.message}`);
    if (result.status !== 0) throw new GitDiffError(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout;
}
