/**
 * What a review checked, in `rigour review --json`: enough to reproduce the verdict and to prove it
 * later (a ledger that compares a local review with CI). The same Rigour version, settings and
 * commits give the same checks.
 */
import { execFileSync } from 'child_process';
import { mergeBaseOf, type ReviewResult } from '@rigour-labs/core';
import { getCliVersion } from '../utils/cli-version.js';
import { configSource } from './review-config.js';

export interface Checked {
    rigour_version: string;
    /** The ref the change was compared with (`--base`), or null for uncommitted work against HEAD. */
    base: string | null;
    /** The commit the comparison started from: the merge base with `base`, or HEAD. */
    base_sha: string | null;
    head_sha: string | null;
    /** Tracked files differed from HEAD, so the review covered work that is not committed. */
    uncommitted: boolean;
    /** The settings read: a path, `<path> at <commit>` for an independent review, or `defaults`. */
    config: string;
    /** Every check the run reached, by id: PASS, FAIL, SKIP or ERROR. A check whose findings were all already in the base, or only on lines the change did not touch, reads PASS. */
    checks: Record<string, string>;
    /** By check, how many findings the base already had: left out of the verdict and of `checks`. */
    preexisting: Record<string, number>;
    /** By check, how many findings sat only on lines the change did not touch: left out of the verdict and of `checks`. */
    outsideChange: Record<string, number>;
}

export function whatWasChecked(cwd: string, options: { base?: string; config?: string }, trustedRef: string | undefined, result: ReviewResult): Checked {
    const head = git(cwd, ['rev-parse', 'HEAD']);
    return {
        rigour_version: getCliVersion(),
        base: options.base ?? null,
        base_sha: options.base ? tryOr(() => mergeBaseOf(cwd, options.base!), null) : head,
        head_sha: head,
        uncommitted: git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '',
        config: configSource(cwd, options, trustedRef),
        checks: { ...(result.report?.summary ?? {}) },
        preexisting: { ...result.preexistingByCheck },
        outsideChange: { ...result.outsideChangeByCheck },
    };
}

function git(cwd: string, args: string[]): string | null {
    return tryOr(() => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), null);
}

function tryOr<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}
