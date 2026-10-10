// Shared by the learning-quality report's scripts: the repositories, the cutoff, and a GitHub reader.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import path from 'path';

/** Public repositories whose review history is public. */
// zulip/zulip was the third; its clone passed the 1 GB cap with both clone modes, so it was replaced by the
// candidate with the most human review comments per merged pull request (logto 0.45, superset 0.40, 20 each).
export const REPOS = ['immich-app/immich', 'tailscale/tailscale', 'logto-io/logto'];
/** Pull requests merged before this are the report's input; fixed so later runs read the same thing. */
export const CUTOFF = '2026-10-01T00:00:00Z';
/**
 * How many pull requests per repository, fixed before any result is read: enough for 40 sampled candidates with
 * margin at the rate the first, stopped run showed (about 0.9 candidates per pull request for immich).
 */
export const PR_COUNT = { 'immich-app/immich': 50, 'tailscale/tailscale': 40, 'logto-io/logto': 40 };
/** One clone mode for every repository, so runs compare: every tree, file contents fetched when read. */
export const CLONE_FILTER = 'blob:none';
/** A clone is stopped past this: the disk is near full. */
export const CLONE_CAP_BYTES = 1024 ** 3;

/** A review bot: a GitHub App account, or a login ending in [bot]. */
export function isBot(user) {
    return user?.type === 'Bot' || /\[bot\]$/i.test(String(user?.login ?? ''));
}

let token;
/** A GitHub REST read with the gh CLI's token (any account: the repositories are public). Never printed. */
export async function github(pathAndQuery) {
    const response = await fetch(`https://api.github.com${pathAndQuery}`, { headers: { Authorization: `Bearer ${githubToken()}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub ${pathAndQuery}: HTTP ${response.status}`);
    return response.json();
}

/** The token GitHub is read with: GITHUB_TOKEN, else gh's. */
export function githubToken() {
    token ??= process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    return token;
}

/** Where a candidate's point came from: the inline comment, or the review whose body it is in (`review-<id>`). */
export function sourceOf(commentId) {
    const review = /^review-(\d+)-\d+$/.exec(commentId);
    return review ? `review-${review[1]}` : commentId;
}

/** The source's page on GitHub, so anyone can check a label. */
export function sourceUrl(repo, pr, source) {
    return source.startsWith('review-') ? `https://github.com/${repo}/pull/${pr}#pullrequestreview-${source.slice(7)}` : `https://github.com/${repo}/pull/${pr}#discussion_r${source}`;
}

/**
 * A candidate text cut mid-thought, judged mechanically: it starts like a continuation (Or / And / But) or ends on a
 * connector (", or", "and"). A lowercase start alone is not: reviewers often write sentences that way.
 */
export function looksBroken(text) {
    const t = String(text ?? '').trim();
    return /^(or|and|but)\b/i.test(t) || /(,\s*(or|and)|\b(or|and|but))\s*[.:]?$/i.test(t);
}

/** Wilson score interval at 95% for k successes of n. */
export function wilson(k, n) {
    if (n === 0) return [0, 0];
    const z = 1.96, p = k / n, d = 1 + z * z / n;
    const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [(c - m) / d, (c + m) / d];
}

/**
 * Where third-party comment text is kept: outside the repository, rebuilt from the URLs by these scripts. The
 * repository holds ids, URLs, labels, counts and hashes only.
 */
export const TEXT_CACHE = process.env.LEARNING_REPORT_CACHE || path.join(os.homedir(), 'Workspace/Projects/Personal/rigour-labs/notes/learning-report');

/** A short hash of a text, so a run can say a candidate's text changed without holding the text. */
export function textHash(text) {
    return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 12);
}

// Recurrence the file-anchored match cannot see: candidate pairs from different pull requests whose content words
// overlap by at least half (Jaccard), whatever their files. A measure for a person to judge, not a rule.
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'should', 'would', 'could', 'there', 'their', 'here', 'what', 'when', 'which', 'will', 'into', 'also', 'just', 'than', 'then', 'they', 'them', 'these', 'those', 'make', 'sure', 'need', 'needs', 'does', 'only', 'more', 'some', 'like', 'please', 'maybe', 'think', 'instead']);
const words = text => new Set(String(text).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g)?.filter(w => !STOP.has(w)) ?? []);

/** `[idA, idB, score]` for candidates (with `id`, `text`, `prs`) on different pull requests, best first. */
export function nearDuplicates(lessons) {
    const pairs = [];
    const bags = lessons.map(l => words(l.text));
    for (let i = 0; i < lessons.length; i++) for (let j = i + 1; j < lessons.length; j++) {
        if (lessons[i].prs.some(p => lessons[j].prs.includes(p))) continue;
        const [a, b] = [bags[i], bags[j]];
        if (a.size < 3 || b.size < 3) continue;
        const both = [...a].filter(w => b.has(w)).length;
        const score = both / (a.size + b.size - both);
        if (score >= 0.5) pairs.push([lessons[i].id, lessons[j].id, Number(score.toFixed(2))]);
    }
    return pairs.sort((x, y) => y[2] - x[2]);
}
