/**
 * Studio's "Pull requests": every pull request Rigour saw on this machine, from the first recorded event on its branch
 * to the merge and after, and what Rigour's review added. A branch a review ran on before it had a pull request is a
 * row of its own. Read from the task threads, the reviewer's records, outcomes.json and the review lessons; never written.
 */
import { readThread, type CiResult, type ThreadEvent } from '@rigour-labs/core';
import { checkoutRoots } from './studio-checkouts.js';
import { lessonsAcross, outcomesAcross, readThreadsSince, recordReader, reviewerDir } from './studio-pulls-data.js';
import { buildDetail, type PullDetail } from './studio-pulls-detail.js';
import { appliedLessons, blockingBeforeMerge, eventsOfPr, mergeOf, roundsOf, stateOf, type Context, type PullState } from './studio-pulls-rounds.js';

const WINDOW_DAYS = 28;
/** The list reads the threads written to in the last 90 days: a branch quiet for longer is left out (see `older`). */
const LIST_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PullRow {
    /** `#42`, or `branch:<name>` for a branch reviewed before it had a pull request. */
    key: string;
    pr: number | null;
    title: string | null;
    branches: string[];
    state: PullState;
    lastReview: { at: string; outcome: string; blocking: number; shouldFix: number } | null;
    rounds: number;
    lessonsApplied: number;
    /** Distinct blocking problems the review found before the merge (see blockingBeforeMerge). */
    blockingFound: number;
    ci: CiResult | null;
    followUps: { commits: number; fixes: number } | null;
    firstAt: string;
    lastActivity: string;
}

export interface PullsList {
    rows: PullRow[];
    /** The last 28 days: pull requests with a review round in them. */
    window: { days: number; reviewed: number; blocking: number; lessonsApplied: number; merged: number; mergedClean: number };
    /** Whether any merge is recorded here (outcomes.json or a thread's merge event): without one, merge numbers are unknown. */
    mergesRecorded: boolean;
    threadsRecorded: boolean;
    /** Only branches with activity in the last `days` are listed; `older` counts the branch threads left out. */
    scope: { days: number; older: number };
}

export function loadPulls(cwd: string, _url?: URL, now = Date.now()): PullsList {
    const ctx = contextFor(cwd);
    const { threads, older } = readThreadsSince(cwd, now - LIST_DAYS * DAY_MS);
    const rows = groups(threads).map(g => rowOf(g, ctx)).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return {
        rows,
        window: windowOf(rows, now),
        mergesRecorded: ctx.outcomes.size > 0 || rows.some(r => r.state === 'merged' || r.state === 'reverted'),
        threadsRecorded: rows.length > 0 || older > 0,
        scope: { days: LIST_DAYS, older },
    };
}

/**
 * One pull request (`?n=42`) or one branch reviewed before its pull request (`?branch=name`). A branch is looked up as
 * a branch only (`branch:` keeps core from reading `42` as pull request #42).
 */
export function loadPull(cwd: string, url?: URL): PullDetail | { found: false; key: string } {
    const n = url?.searchParams.get('n')?.replace(/^#/, '') ?? '';
    const branch = url?.searchParams.get('branch')?.trim() ?? '';
    const pr = /^\d{1,7}$/.test(n) ? Number(n) : null;
    const key = pr !== null ? `#${pr}` : branch ? `branch:${branch}` : '';
    const thread = key ? readThread(cwd, key) : undefined;
    if (!thread?.events.length) return { found: false, key };
    // A branch opened by name that has since had a pull request is that pull request.
    const named = pr ?? [...thread.events].reverse().map(e => e.pr).find((p): p is number => typeof p === 'number') ?? null;
    return buildDetail(named !== null && pr === null ? `#${named}` : key, named, eventsOfPr(thread.events, named), contextFor(cwd));
}

function contextFor(cwd: string): Context {
    const roots = checkoutRoots(cwd);
    return {
        record: recordReader(reviewerDir(cwd)),
        lessons: new Map(lessonsAcross(roots).map(l => [l.id, l])),
        outcomes: outcomesAcross(roots),
    };
}

interface Group { key: string; pr: number | null; events: ThreadEvent[] }

/** A pull request gathers every branch thread that names it; a branch with a review and no pull request stands alone. */
function groups(threads: ThreadEvent[][]): Group[] {
    const byKey = new Map<string, Group>();
    const add = (key: string, pr: number | null, events: ThreadEvent[]) => {
        const group = byKey.get(key) ?? { key, pr, events: [] };
        group.events.push(...events);
        byKey.set(key, group);
    };
    for (const events of threads) {
        const prs = [...new Set(events.map(e => e.pr).filter((p): p is number => typeof p === 'number'))];
        if (prs.length) prs.forEach(pr => add(`#${pr}`, pr, eventsOfPr(events, pr)));
        else if (events.some(e => e.kind === 'review')) add(`branch:${events[events.length - 1].branch}`, null, events);
    }
    return [...byKey.values()].map(g => ({ ...g, events: g.events.sort((a, b) => a.at.localeCompare(b.at)) }));
}

function rowOf(g: Group, ctx: Context): PullRow {
    const rounds = roundsOf(g.events, ctx);
    const merge = mergeOf(g.pr, g.events, ctx);
    const last = rounds.at(-1);
    return {
        key: g.key,
        pr: g.pr,
        title: [...g.events].reverse().map(e => e.pr_title).find((t): t is string => typeof t === 'string') ?? null,
        branches: [...new Set(g.events.map(e => e.branch))],
        state: stateOf(g.pr, merge),
        lastReview: last ? { at: last.at, outcome: last.outcome, blocking: last.blocking, shouldFix: last.shouldFix } : null,
        rounds: rounds.length,
        lessonsApplied: appliedLessons(rounds).length,
        blockingFound: blockingBeforeMerge(rounds, merge?.at ?? null),
        ci: merge?.ci ?? null,
        followUps: merge && merge.followUpCount !== null ? { commits: merge.followUpCount, fixes: merge.fixes ?? 0 } : null,
        firstAt: g.events[0].at,
        lastActivity: [g.events[g.events.length - 1].at, merge?.at ?? ''].sort().at(-1)!,
    };
}

/** The KPIs: pull requests (with a number) whose last review round falls in the window. */
function windowOf(rows: PullRow[], now: number): PullsList['window'] {
    const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
    const recent = rows.filter(r => r.pr !== null && r.lastReview && r.lastReview.at >= since);
    const merged = recent.filter(r => r.state === 'merged' || r.state === 'reverted');
    return {
        days: WINDOW_DAYS,
        reviewed: recent.length,
        blocking: recent.reduce((n, r) => n + r.blockingFound, 0),
        lessonsApplied: recent.reduce((n, r) => n + r.lessonsApplied, 0),
        merged: merged.length,
        mergedClean: merged.filter(r => r.state === 'merged').length,
    };
}
