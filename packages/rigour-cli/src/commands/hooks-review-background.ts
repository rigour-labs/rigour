/**
 * `rigour hooks review-background --commit <sha> --branch <name> --base <ref>`: the detached
 * process the push gate starts once the deterministic gates pass (core review/reviewer/background.ts).
 * It reviews the pushed commit in a worktree of its own and records the verdict; the push did not wait.
 */
import { backgroundReview } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

export async function hooksReviewBackgroundCommand(cwd: string, options: { commit: string; branch: string; base: string; config?: string }): Promise<number> {
    const config = await loadConfig(cwd, options);
    const result = await backgroundReview(cwd, { head: options.commit, branch: options.branch, base: options.base }, config);
    return result.outcome === 'findings' || result.outcome === 'unavailable' ? 1 : 0;
}
