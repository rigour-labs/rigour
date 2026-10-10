/**
 * `rigour learn-reviews`: turn a repository's review points into lessons, on evidence. Reads GitHub
 * (merged PRs, their review comments and review bodies) and the local clone; writes only
 * .rigour/review-lessons.json (and, with rules, the audit log beside it).
 *
 * Every point is a candidate, whoever wrote it: a person, an AI posting under a person's login, a
 * review bot. Who wrote it, and whether the pull request changed those lines, are recorded and never
 * decide anything: agents apply review comments on their own, and people paste AI text. Evidence
 * decides (lessons.ts lessonState): what later happened to the lines (outcomes.ts), a person's
 * decision, or the same point recurring across pull requests by different authors. The pull
 * request's author commenting on their own pull request is not a review point.
 */
import { changedSince, gitIn, withActedOn, type Git, type MergedPr, type ReviewBody, type ReviewComment } from './acted-on.js';
import { outcomeFor, revertOf } from './outcomes.js';
import fs from 'fs';
import path from 'path';
import type { NotRequestReason } from './requests.js';
import { lessonFromComment, lessonsFromReview, lessonsPath, lessonState, mergeLessons, readLessons, writeLessons, type ReviewLesson } from './lessons.js';
import { rulesFromReviews, type RuleWriter } from './rules-from-reviews.js';

type Fetch = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface LearnFromReviewsOptions {
    token: string;
    /** Who the token reads as, for an error message (githubReader): an account, or where the token came from. Never the token. */
    readAs?: string;
    /** owner/name */
    repo: string;
    /** Only PRs merged on or after this ISO date. */
    since?: string;
    /** Only PRs merged before this ISO date (a time split for measuring); with `pr`, only reviews posted before it. */
    until?: string;
    /**
     * Learn from this one pull request, open or merged: its reviews up to `until`, acted on when files
     * changed after a review by its head as of `until`. A long-running pull request teaches as it goes.
     */
    pr?: number;
    limit?: number;
    /** The main branch, for outcome evidence (what later happened to the lines); none is gathered without it. */
    mainRef?: string;
    /** How long a point's unchanged lines must ship before that counts against it. */
    windowDays?: number;
    /** Rewrite each newly promoted lesson as the rule behind it, or drop it as no rule (rules-from-reviews.ts); off: the words as they are. */
    writeRules?: RuleWriter;
    apiUrl?: string;
    fetch?: Fetch;
    git?: Git;
}

export interface LearnFromReviewsResult {
    prs: number;
    comments: number;
    actedOn: number;
    /** Review bodies read (each point in one is a candidate). */
    reviewBodies: number;
    /** Candidate points read this run, by who wrote them. */
    candidates: { person: number; bot: number };
    /** Points that ask for nothing (review tool status, a description of the change, praise, status reports), by why: skipped, not learned. */
    skipped: Partial<Record<NotRequestReason, number>>;
    /** Lessons now promoted, by the evidence that promoted them; anti-lessons; candidates held back by counter-evidence. */
    promoted: Record<'outcome' | 'correction' | 'person' | 'recurrence' | 'legacy', number>;
    rejected: number;
    heldBack: number;
    /** With writeRules: points rewritten as rules, and points the model called no rule (dropped). */
    rules?: number;
    notRules?: number;
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
    let bodies = 0;
    const skipped: Partial<Record<NotRequestReason, number>> = {};
    const onSkip = (reason: NotRequestReason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    for (const pr of prs) {
        comments += pr.comments.length;
        for (const comment of withActedOn(git, pr)) {
            if (comment.actedOn) acted++;
            const lesson = lessonFromComment(git, comment, undefined, onSkip);
            if (lesson) lessons.push(lesson);
        }
        for (const review of pr.reviews) {
            bodies++;
            lessons.push(...lessonsFromReview(review, changedSince(git, review.commit, pr.mergeSha), undefined, onSkip));
        }
    }
    const known = new Set(readLessons(cwd).flatMap(l => l.evidence.map(e => e.comment)));
    const points = lessons.flatMap(l => l.evidence).filter(e => e.kind === 'point' && !known.has(e.comment));
    // Comments read before go through too: each lands on its own lesson (mergeLessons matches the comment), which
    // takes the text this version derives from it. Nothing is added twice.
    const merged = mergeLessons(readLessons(cwd), lessons);
    // Outcomes accrue after the merge: every candidate whose pull request was read this run is checked again.
    if (options.mainRef) {
        const byNumber = new Map(prs.filter(pr => pr.mergedAt).map(pr => [pr.number, pr]));
        const reverts = new Map([...byNumber.values()].map(pr => [pr.number, revertOf(git, pr, { mainRef: options.mainRef!, until: options.until })]));
        for (const lesson of merged.lessons) {
            if (lesson.state !== 'candidate' || lesson.evidence.some(e => e.kind === 'outcome' || e.kind === 'lines' || e.kind === 'counter')) continue;
            for (const point of lesson.evidence.filter(e => (e.kind ?? 'point') === 'point')) {
                const pr = byNumber.get(point.pr);
                if (!pr) continue;
                const found = (point.actedOn === false ? reverts.get(pr.number) : undefined) ?? outcomeFor(git, lesson, pr, { mainRef: options.mainRef, until: options.until, windowDays: options.windowDays });
                if (found) {
                    // A fix on the point's lines, or a revert, is evidence for a person to promote in Studio, never a promotion (lessonState).
                    lesson.evidence.push(found.kind === 'outcome' ? { ...found, kind: 'lines' } : found);
                    break;
                }
            }
        }
        for (const lesson of merged.lessons) Object.assign(lesson, lessonState(lesson));
    }
    // Rules are written for what evidence promoted, once: the model is paid only for lessons that will be served.
    let written: Awaited<ReturnType<typeof rulesFromReviews>> | undefined;
    const unwritten = merged.lessons.filter(l => l.state === 'verified' && !l.evidence.some(e => e.said));
    if (options.writeRules && unwritten.length) {
        written = await rulesFromReviews(unwritten, options.writeRules);
        auditRules(cwd, unwritten, written.lessons);
        const replaced = new Set(unwritten.map(l => l.id));
        merged.lessons = [...merged.lessons.filter(l => !replaced.has(l.id)), ...written.lessons.map(l => ({ ...l, ...lessonState(l) }))];
    }
    writeLessons(cwd, merged.lessons);
    const promoted = { outcome: 0, correction: 0, person: 0, recurrence: 0, legacy: 0 };
    for (const l of merged.lessons) if (l.state === 'verified' && l.promotedBy) promoted[l.promotedBy]++;
    return {
        prs: prs.length, comments, actedOn: acted, reviewBodies: bodies,
        candidates: { person: points.filter(e => e.source !== 'bot').length, bot: points.filter(e => e.source === 'bot').length },
        skipped,
        promoted, rejected: merged.lessons.filter(l => l.state === 'rejected').length,
        heldBack: merged.lessons.filter(l => l.state === 'candidate' && l.evidence.some(e => e.kind === 'counter')).length,
        ...(written ? { rules: written.rules, notRules: written.dropped } : {}),
        added: merged.added, verified: merged.lessons.filter(l => l.state === 'verified').length, total: merged.lessons.length,
    };
}

/**
 * Why a GitHub read failed. With several accounts, 401, 403 and 404 most often mean this account cannot see the
 * repository, not that it is the wrong one: say which account read it, and how to name another. Never the token.
 */
function cannotRead(options: LearnFromReviewsOptions, status: number, path: string): string {
    if (status !== 401 && status !== 403 && status !== 404) return `GitHub ${path}: HTTP ${status}`;
    return `can't read ${options.repo} as ${options.readAs ?? 'this token'} (HTTP ${status}): the account may not have access; name another with review.github_account / RIGOUR_GITHUB_ACCOUNT, or check gh auth status. Asked for ${path}.`;
}

async function mergedPrs(options: LearnFromReviewsOptions): Promise<MergedPr[]> {
    const fetchImpl = options.fetch ?? (fetch as unknown as Fetch);
    const base = `${(options.apiUrl || 'https://api.github.com').replace(/\/$/, '')}/repos/${options.repo}`;
    const get = async (url: string) => {
        const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/vnd.github+json' } });
        if (!response.ok) throw new Error(cannotRead(options, response.status, url.replace(base, '')));
        return response.json();
    };
    if (options.pr !== undefined) return [await onePr(options, base, get)];
    const limit = options.limit ?? 100;
    const prs: MergedPr[] = [];
    for (let page = 1; prs.length < limit && page <= 20; page++) {
        const batch: any[] = await get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
        if (batch.length === 0) break;
        for (const pr of batch) {
            if (!pr.merged_at || !pr.merge_commit_sha) continue;
            if (options.since && pr.merged_at < options.since) continue;
            if (options.until && pr.merged_at >= options.until) continue;
            const author = String(pr.user?.login ?? '');
            const reviewer = (user: any) => !!user?.login && user.login !== author;
            const raw: any[] = await get(`${base}/pulls/${pr.number}/comments?per_page=100`);
            const reviews: any[] = await get(`${base}/pulls/${pr.number}/reviews?per_page=100`);
            // As of --until: a merged pull request still gathers comments after it; those are not in the store as of then.
            prs.push({
                number: pr.number, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at,
                comments: raw.filter(c => reviewer(c.user) && postedBefore(options.until, c.created_at)).flatMap(c => toComment(pr.number, c, author, options.until)),
                reviews: reviews.filter(r => reviewer(r.user) && postedBefore(options.until, r.submitted_at) && r.commit_id && String(r.body ?? '').trim()).map((r): ReviewBody => ({ id: String(r.id), prNumber: pr.number, commit: r.commit_id, body: String(r.body), author: String(r.user.login), source: sourceOf(r.user), prAuthor: author })),
            });
            if (prs.length >= limit) break;
        }
    }
    return prs;
}

/** One pull request as of `until`: its head then, and the reviews by people posted before it. */
async function onePr(options: LearnFromReviewsOptions, base: string, get: (url: string) => Promise<any>): Promise<MergedPr> {
    const pr = await get(`${base}/pulls/${options.pr}`);
    const before = (at: unknown) => postedBefore(options.until, at);
    // Every page: a long-running pull request has hundreds of commits and comments.
    const all = async (url: string) => {
        const items: any[] = [];
        for (let page = 1; page <= 30; page++) {
            const batch: any[] = await get(`${url}?per_page=100&page=${page}`);
            items.push(...batch);
            if (batch.length < 100) break;
        }
        return items;
    };
    const commits = await all(`${base}/pulls/${options.pr}/commits`);
    const atUntil = commits.filter(c => before(c.commit?.committer?.date)).at(-1)?.sha;
    const head = atUntil ?? pr.head?.sha;
    const author = String(pr.user?.login ?? '');
    const reviewer = (user: any) => !!user?.login && user.login !== author;
    const raw = await all(`${base}/pulls/${options.pr}/comments`);
    const reviews = await all(`${base}/pulls/${options.pr}/reviews`);
    return {
        number: Number(options.pr), mergeSha: head, mergedAt: pr.merged_at ?? '',
        comments: raw.filter(c => reviewer(c.user) && before(c.created_at)).flatMap(c => toComment(Number(options.pr), c, author, options.until)),
        reviews: reviews.filter(r => reviewer(r.user) && before(r.submitted_at) && r.commit_id && String(r.body ?? '').trim())
            .map((r): ReviewBody => ({ id: String(r.id), prNumber: Number(options.pr), commit: r.commit_id, body: String(r.body), author: String(r.user.login), source: sourceOf(r.user), prAuthor: author })),
    };
}

/** Posted before `until` (when one is given): what a store as of `until` could have read. */
function postedBefore(until: string | undefined, at: unknown): boolean {
    return !until || (typeof at === 'string' && at < until);
}

/** A review comment where it was written; marked when edited at or after `until`, since only its edited text is served. */
function toComment(prNumber: number, c: any, prAuthor: string, until?: string): ReviewComment[] {
    const end = c.original_line ?? c.line;
    const commit = c.original_commit_id ?? c.commit_id;
    if (!c.path || !end || !commit || c.in_reply_to_id) return [];
    const start = c.original_start_line ?? c.start_line ?? end;
    const edited = !!until && typeof c.updated_at === 'string' && c.updated_at >= until;
    return [{ id: String(c.id), prNumber, path: c.path, start: Math.min(start, end), end, commit, body: String(c.body ?? ''), author: String(c.user?.login ?? ''), source: sourceOf(c.user), prAuthor, ...(edited ? { editedAfterUntil: true as const } : {}) }];
}

/** A GitHub App or a bot account (`type: Bot`, or a login like `name[bot]`), else a person's login, whose text may itself be an AI's. */
function sourceOf(user: any): 'person' | 'bot' {
    return user?.type === 'Bot' || /\[bot\]$|bot$/i.test(String(user?.login ?? '')) ? 'bot' : 'person';
}

/** Every point the model judged, with the person's words and what it made of them (a rule, or none), beside the lessons for audit. */
function auditRules(cwd: string, points: ReviewLesson[], kept: ReviewLesson[]): void {
    const at = new Date().toISOString();
    const byComment = new Map(kept.flatMap(l => l.evidence.map(e => [e.comment, l] as const)));
    const lines = points.map(p => {
        const e = p.evidence[0];
        const rule = byComment.get(e.comment);
        return JSON.stringify({ at, pr: e.pr, author: e.author, said: p.text, rule: rule && rule.text !== p.text ? rule.text : rule ? '(kept as said)' : null });
    });
    const file = path.join(path.dirname(lessonsPath(cwd)), 'review-rules-log.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${lines.join('\n')}\n`);
}
