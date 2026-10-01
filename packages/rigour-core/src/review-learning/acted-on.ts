/**
 * Which review comments a developer acted on: the lines a comment points at
 * changed between the commit it was written on and the merged result.
 *
 * Acted-on comments are review work the team valued, whoever wrote them (a
 * person, a review bot, Rigour). A comment nobody acted on is not evidence of
 * anything and never becomes a lesson.
 */
import { execFileSync } from 'child_process';

export interface ReviewComment {
    id: string;
    prNumber: number;
    path: string;
    /** Lines the comment covers on its commit (start ≤ end). */
    start: number;
    end: number;
    /** The commit the comment was written on. */
    commit: string;
    body: string;
    author: string;
}

export interface MergedPr {
    number: number;
    mergeSha: string;
    mergedAt: string;
    comments: ReviewComment[];
}

/** git in one repository; tests substitute their own. */
export type Git = (args: string[]) => string;

export function gitIn(cwd: string): Git {
    return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Acted-on comments of a merged PR; comments whose commit or file cannot be found are skipped. */
export function actedOn(git: Git, pr: MergedPr): ReviewComment[] {
    ensureCommits(git, pr);
    return pr.comments.filter(comment => {
        if (!hasFile(git, comment.commit, comment.path) || !hasFile(git, pr.mergeSha, comment.path)) return false;
        return changedHunks(git, comment.commit, pr.mergeSha, comment.path).some(([s, e]) => s <= comment.end && comment.start <= e);
    });
}

/** Old-side line ranges that changed between two commits in one file. */
export function changedHunks(git: Git, from: string, to: string, file: string): Array<[number, number]> {
    let diff = '';
    try {
        diff = git(['diff', '--no-color', '-U0', from, to, '--', file]);
    } catch {
        return [];
    }
    const hunks: Array<[number, number]> = [];
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
        const start = Number(match[1]);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        // A pure insertion (count 0) sits after `start`; it touches that line.
        hunks.push([start, start + Math.max(count, 1) - 1]);
    }
    return hunks;
}

/** Commits a comment was written on may have been force-pushed away; GitHub still serves the PR ref. */
function ensureCommits(git: Git, pr: MergedPr): void {
    const missing = [...new Set(pr.comments.map(c => c.commit))].filter(sha => !hasCommit(git, sha));
    if (missing.length === 0) return;
    try {
        git(['fetch', '-q', 'origin', `pull/${pr.number}/head`]);
    } catch {
        // Offline or no remote: the comments on missing commits are skipped.
    }
}

function hasCommit(git: Git, sha: string): boolean {
    try {
        git(['cat-file', '-e', `${sha}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

function hasFile(git: Git, sha: string, file: string): boolean {
    try {
        git(['cat-file', '-e', `${sha}:${file}`]);
        return true;
    } catch {
        return false;
    }
}
