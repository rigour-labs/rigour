/**
 * Which review comments a developer acted on: the lines a comment points at
 * changed between the commit it was written on and the merged result.
 *
 * Acted-on comments are review work the team valued. The learner keeps the
 * people's by default (a review bot's acted-on comments are mostly one-off fixes,
 * and on a busy repository they outnumber the people's many times over). A
 * comment nobody acted on is not evidence of anything and never becomes a lesson.
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
    source?: 'person' | 'bot';
    prAuthor?: string;
    /** Whether the lines it points at changed before the merge. */
    actedOn?: boolean;
    /** Edited at or after `--until`: its text is the edited one, which the store as of `until` would not have had. */
    editedAfterUntil?: true;
}

/** A review's body: where a reviewer makes the points that are not about one line. */
export interface ReviewBody {
    id: string;
    prNumber: number;
    /** The commit the review was written on. */
    commit: string;
    body: string;
    author: string;
    source?: 'person' | 'bot';
    prAuthor?: string;
}

export interface MergedPr {
    number: number;
    mergeSha: string;
    mergedAt: string;
    comments: ReviewComment[];
    reviews: ReviewBody[];
}

/** git in one repository; tests substitute their own. */
export type Git = (args: string[]) => string;

export function gitIn(cwd: string): Git {
    return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Every comment whose commit and file can be found, each marked whether its lines changed before the merge. */
export function withActedOn(git: Git, pr: MergedPr): ReviewComment[] {
    ensureCommits(git, pr);
    return pr.comments.flatMap(comment => {
        if (!hasFile(git, comment.commit, comment.path) || !hasFile(git, pr.mergeSha, comment.path)) return [];
        const acted = changedHunks(git, comment.commit, pr.mergeSha, comment.path).some(([s, e]) => s <= comment.end && comment.start <= e);
        return [{ ...comment, actedOn: acted }];
    });
}

/** Files the PR changed after a review was written: acted on when there are any. Empty when the commit is unavailable. */
export function changedSince(git: Git, from: string, to: string): string[] {
    try {
        return git(['diff', '--name-only', from, to]).split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

/** A changed range on the old side, with how many lines it removed and added (a pure insertion removes none). */
export type Hunk = [start: number, end: number, removed: number, added: number];

/** Old-side line ranges that changed between two commits in one file. */
export function changedHunks(git: Git, from: string, to: string, file: string): Hunk[] {
    let diff = '';
    try {
        diff = git(['diff', '--no-color', '-U0', from, to, '--', file]);
    } catch {
        return [];
    }
    const hunks: Hunk[] = [];
    for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
        const start = Number(match[1]);
        const removed = match[2] === undefined ? 1 : Number(match[2]);
        const added = match[3] === undefined ? 1 : Number(match[3]);
        // A pure insertion (removed 0) sits after `start`; it touches that line.
        hunks.push([start, start + Math.max(removed, 1) - 1, removed, added]);
    }
    return hunks;
}

/** Commits a comment was written on may have been force-pushed away; GitHub still serves the PR ref. */
function ensureCommits(git: Git, pr: MergedPr): void {
    const missing = [...new Set([...pr.comments.map(c => c.commit), ...pr.reviews.map(r => r.commit)])].filter(sha => !hasCommit(git, sha));
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
