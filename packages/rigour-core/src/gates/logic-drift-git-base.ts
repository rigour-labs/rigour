import { execFileSync } from 'node:child_process';

export interface GitLogicBase {
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

/** Use a fixed commit for the entire scan; never move the baseline on read. */
export function resolveGitLogicBase(cwd: string): GitLogicBase | null {
    // Git reports the path relative to the worktree root without relying on
    // platform-specific path casing or Windows short-name expansion.
    const prefix = git(cwd, ['rev-parse', '--show-prefix']);
    if (prefix === null || prefix.trim()) return null;

    const currentBranch = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
    const candidates = [
        process.env.GITHUB_BASE_REF ? `refs/remotes/origin/${process.env.GITHUB_BASE_REF}` : '',
        'refs/remotes/origin/main', 'refs/heads/main',
        'refs/remotes/origin/master', 'refs/heads/master',
    ].filter(Boolean);
    const mainRef = candidates.find(ref => git(cwd, ['rev-parse', '--verify', '--quiet', ref])?.trim());
    if (!mainRef) return null;

    const base = currentBranch === 'main' || currentBranch === 'master'
        ? git(cwd, ['rev-parse', 'HEAD'])?.trim()
        : git(cwd, ['merge-base', 'HEAD', mainRef])?.trim();
    if (!base) return null;

    const diff = git(cwd, ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--']);
    if (diff === null) return null;
    return {
        changedFiles: new Set(diff.split('\0').filter(Boolean)),
        readAtBase: file => git(cwd, ['show', `${base}:${file}`]),
    };
}
