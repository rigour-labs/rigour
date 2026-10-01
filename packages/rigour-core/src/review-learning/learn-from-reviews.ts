/**
 * `rigour learn --from-reviews`: turn a repository's acted-on review comments
 * into review lessons. Reads GitHub (merged PRs and their review comments) and
 * the local clone; writes only .rigour/review-lessons.json.
 */
import { actedOn, gitIn, type Git, type MergedPr, type ReviewComment } from './acted-on.js';
import { lessonFromComment, mergeLessons, readLessons, writeLessons, type ReviewLesson } from './lessons.js';

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface LearnFromReviewsOptions {
    token: string;
    /** owner/name */
    repo: string;
    /** Only PRs merged on or after this ISO date. */
    since?: string;
    /** Only PRs merged before this ISO date (a time split for measuring). */
    until?: string;
    limit?: number;
    apiUrl?: string;
    fetch?: Fetch;
    git?: Git;
}

export interface LearnFromReviewsResult {
    prs: number;
    comments: number;
    actedOn: number;
    added: number;
    verified: number;
    total: number;
}

export async function learnFromReviews(cwd: string, options: LearnFromReviewsOptions): Promise<LearnFromReviewsResult> {
    const git = options.git ?? gitIn(cwd);
    const prs = await mergedPrs(options);
    const lessons: ReviewLesson[] = [];
    let comments = 0;
    let acted = 0;
    for (const pr of prs) {
        comments += pr.comments.length;
        for (const comment of actedOn(git, pr)) {
            acted++;
            const lesson = lessonFromComment(git, comment);
            if (lesson) lessons.push(lesson);
        }
    }
    const merged = mergeLessons(readLessons(cwd), lessons);
    writeLessons(cwd, merged.lessons);
    return { prs: prs.length, comments, actedOn: acted, added: merged.added, verified: merged.verified, total: merged.lessons.length };
}

async function mergedPrs(options: LearnFromReviewsOptions): Promise<MergedPr[]> {
    const fetchImpl = options.fetch ?? (fetch as unknown as Fetch);
    const base = `${(options.apiUrl || 'https://api.github.com').replace(/\/$/, '')}/repos/${options.repo}`;
    const get = async (url: string) => {
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error(`GitHub ${url.replace(base, '')}: HTTP ${response.status}`);
        return response.json();
    };
    const limit = options.limit ?? 100;
    const prs: MergedPr[] = [];
    for (let page = 1; prs.length < limit && page <= 20; page++) {
        const batch: any[] = await get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (batch.length === 0) break;
        for (const pr of batch) {
            if (!pr.merged_at || !pr.merge_commit_sha) continue;
            if (options.since && pr.merged_at < options.since) continue;
            if (options.until && pr.merged_at >= options.until) continue;
            const raw: any[] = await get(`${base}/pulls/${pr.number}/comments?per_page=100`);
            prs.push({ number: pr.number, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, comments: raw.flatMap(c => toComment(pr.number, c)) });
            if (prs.length >= limit) break;
        }
    }
    return prs;
}

/** A review comment where it was written: its original commit and lines. */
function toComment(prNumber: number, c: any): ReviewComment[] {
    const end = c.original_line ?? c.line;
    const commit = c.original_commit_id ?? c.commit_id;
    if (!c.path || !end || !commit || c.in_reply_to_id) return [];
    const start = c.original_start_line ?? c.start_line ?? end;
    return [{ id: String(c.id), prNumber, path: c.path, start: Math.min(start, end), end, commit, body: String(c.body ?? ''), author: String(c.user?.login ?? '') }];
}
