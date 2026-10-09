import { execFileSync } from 'node:child_process';

export interface GitLogicBase {
    /** The commit compared against. */
    base: string;
    /** Tracked files that differ from the base (added, copied, modified, renamed). Untracked files are not in it. */
    changedFiles: Set<string>;
    readAtBase: (file: string) => string | null;
}

export function isGitWorktree(cwd: string): boolean {
    return git(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch {
        return null;
    }
}

export interface BranchBase {
    /** The main branch as found: GITHUB_BASE_REF, else origin/main, main, origin/master, master. */
    mainRef: string;
    /** Where the branch left it (merge-base), or HEAD when on main itself. */
    base: string;
    onMain: boolean;
}

/** The commit a branch is measured against, or null outside a repository or without a main branch. */
export function branchBase(cwd: string): BranchBase | null {
    const currentBranch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
    const candidates = [
        process.env.GITHUB_BASE_REF ? `refs/remotes/origin/${process.env.GITHUB_BASE_REF}` : '',
        'refs/remotes/origin/main', 'refs/heads/main',
        'refs/remotes/origin/master', 'refs/heads/master',
    ].filter(Boolean);
    const mainRef = candidates.find(ref => git(cwd, ['rev-parse', '--verify', '--quiet', ref])?.trim());
    if (!mainRef) return null;
    const onMain = currentBranch === 'main' || currentBranch === 'master';
    const base = onMain ? git(cwd, ['rev-parse', 'HEAD'])?.trim() : git(cwd, ['merge-base', 'HEAD', mainRef])?.trim();
    return base ? { mainRef, base, onMain } : null;
}

/** Use a fixed commit for the entire scan; never move the baseline on read. */
export function resolveGitLogicBase(cwd: string): GitLogicBase | null {
    // Git reports the path relative to the worktree root without relying on
    // platform-specific path casing or Windows short-name expansion.
    const prefix = git(cwd, ['rev-parse', '--show-prefix']);
    if (prefix === null || prefix.trim()) return null;
    const branch = branchBase(cwd);
    if (!branch) return null;
    const base = branch.base;

    const diff = git(cwd, ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--']);
    if (diff === null) return null;
    return {
        base,
        changedFiles: new Set(diff.split('\0').filter(Boolean)),
        readAtBase: file => git(cwd, ['show', `${base}:${file}`]),
    };
}

/** Files git does not track and does not ignore: what an agent just created. */
export function untrackedFiles(cwd: string): string[] {
    return (git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '').split('\0').filter(Boolean);
}

/** Every file committed at `commit`, repository-relative with `/`. */
export function filesAtCommit(cwd: string, commit: string): string[] {
    return (git(cwd, ['ls-tree', '-r', '--name-only', '-z', commit]) ?? '').split('\0').filter(Boolean);
}

/** The contents of `files` at `commit`, read by one git process; a file missing there is left out. */
export function readManyAtCommit(cwd: string, commit: string, files: string[]): Map<string, string> {
    const contents = new Map<string, string>();
    if (files.length === 0) return contents;
    let out: Buffer;
    try {
        out = execFileSync('git', ['cat-file', '--batch'], { cwd, input: files.map(file => `${commit}:${file}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    } catch {
        return contents;
    }
    let at = 0;
    for (const file of files) {
        const end = out.indexOf(0x0a, at);
        if (end < 0) break;
        const header = out.subarray(at, end).toString('utf8').split(' ');
        at = end + 1;
        if (header[1] !== 'blob') continue; // "<name> missing", or not a file
        const size = Number(header[2]);
        contents.set(file, out.subarray(at, at + size).toString('utf8'));
        at += size + 1;
    }
    return contents;
}
