/**
 * One pull request's thread, summed up: its review rounds with what each record says, and its merge as recorded. Shared
 * by the list (a row per pull request) and the detail (a timeline). Everything here is what Rigour recorded; a value it
 * did not record is null, never 0.
 */
import type { CiResult, PrOutcome, ReviewLesson, ThreadEvent } from '@rigour-labs/core';
import { num, short, strings, type RecordRead } from './studio-pulls-data.js';

export interface Judge { reviewer: string; model: string | null; version: string | null }

/** A cost a judge (or the review's runs) reported; `basis` says whose figure it is. */
export interface ReportedCost { usd: number; by: string; basis: 'judge' | 'all runs' | 'review' }

export interface Round {
    at: string;
    head: string | null;
    trigger: string | null;
    outcome: string;
    blocking: number;
    shouldFix: number;
    judges: Judge[];
    /** The review's record was found in the reviewer's store on this machine. */
    recorded: boolean;
    rules: { served: number; followed: number; broken: number; notApplicable: number; brokenNames: string[] } | null;
    lessons: { served: number | null; applied: Array<{ id: string; text: string | null }> };
    disputed: number | null;
    /** People's reviews the judges read; null when not recorded, or when the review ran without the pull request (blind). */
    humanReviews: number | null;
    blind: boolean;
    blockingIds: string[];
    cost: ReportedCost[];
}

export type PullState = 'not-opened' | 'open' | 'merged' | 'reverted';

export interface Merge {
    at: string;
    sha: string | null;
    ci: CiResult | null;
    followUps: Array<{ sha: string; at: string; subject: string; fix: boolean }> | null;
    followUpCount: number | null;
    fixes: number | null;
    reverted: { sha: string | null; subject: string | null } | null;
    settled: boolean;
    author: string | null;
    /** outcomes.json: the follow-up commits by name; thread: counts only. */
    source: 'outcomes' | 'thread';
}

export interface Context {
    record: (head: unknown, integrity: unknown) => RecordRead | undefined;
    lessons: Map<string, ReviewLesson>;
    outcomes: Map<number, PrOutcome>;
}

/** Each review event, oldest first, with its record when this machine keeps it. */
export function roundsOf(events: ThreadEvent[], ctx: Context): Round[] {
    return events.filter(e => e.kind === 'review').map(e => round(e, ctx));
}

function round(e: ThreadEvent, ctx: Context): Round {
    const read = ctx.record(e.head, e.integrity);
    const r = read?.record;
    const judges: Judge[] = r
        ? r.judges.map(j => ({ reviewer: j.reviewer, model: j.model ?? null, version: j.version ?? null }))
        : strings(e.judges).map(reviewer => ({ reviewer, model: null, version: null }));
    return {
        at: e.at,
        head: typeof e.head === 'string' ? e.head : null,
        trigger: typeof e.trigger === 'string' ? e.trigger : null,
        outcome: typeof e.outcome === 'string' ? e.outcome : 'unknown',
        blocking: num(e.blocking),
        shouldFix: num(e.should_fix),
        judges,
        recorded: !!r,
        rules: r ? { served: r.verified.rules.served, followed: r.verified.rules.followed, broken: r.verified.rules.broken, notApplicable: r.verified.rules.not_applicable, brokenNames: read!.brokenRules } : null,
        lessons: { served: r ? r.verified.lessons.served : null, applied: strings(e.lessons_applied).map(id => ({ id, text: lessonText(ctx, id) })) },
        disputed: r ? r.verified.disputed : null,
        humanReviews: r && !r.blind ? r.reported.human_reviews : null,
        blind: r?.blind === true,
        blockingIds: r ? r.verified.blocking.map(i => i.id) : [],
        cost: costOf(e, read),
    };
}

function lessonText(ctx: Context, id: string): string | null {
    const lesson = ctx.lessons.get(id);
    return lesson ? short(lesson.text, 160) : null;
}

/** What the judges reported: each judge's own figure from the record, else the review's total for its judges. */
function costOf(e: ThreadEvent, read: RecordRead | undefined): ReportedCost[] {
    const own = (read?.record.judges ?? []).filter(j => typeof j.cost_usd === 'number').map(j => ({ usd: j.cost_usd!, by: j.reviewer, basis: 'judge' as const }));
    if (own.length) return own;
    if (typeof e.cost_usd !== 'number' || !Number.isFinite(e.cost_usd)) return [];
    const by = strings(e.judges).join(' and ') || 'the reviewer';
    return [{ usd: e.cost_usd, by, basis: e.cost_basis === 'runs' ? 'all runs' : 'review' }];
}

/** The merge as recorded: outcomes.json first (it names the follow-ups), else the thread's merge and outcome events. */
export function mergeOf(pr: number | null, events: ThreadEvent[], ctx: Context): Merge | null {
    const outcome = pr === null ? undefined : ctx.outcomes.get(pr);
    if (outcome) return fromOutcome(outcome);
    const merge = [...events].reverse().find(e => e.kind === 'merge' && (pr === null || e.pr === pr));
    if (!merge) return null;
    const settled = [...events].reverse().find(e => e.kind === 'outcome' && e.pr === merge.pr);
    return {
        at: typeof merge.merged_at === 'string' ? merge.merged_at : merge.at,
        sha: typeof merge.merge_sha === 'string' ? merge.merge_sha : null,
        ci: settled && typeof settled.ci === 'string' ? settled.ci as CiResult : null,
        followUps: null,
        followUpCount: settled ? num(settled.follow_ups) : null,
        fixes: settled ? num(settled.fixes) : null,
        reverted: settled?.reverted === true ? { sha: null, subject: null } : null,
        settled: !!settled,
        author: null,
        source: 'thread',
    };
}

function fromOutcome(o: PrOutcome): Merge {
    const followUps = (o.followUps ?? []).map(f => ({ sha: f.sha, at: f.at, subject: short(f.subject, 120), fix: f.fix }));
    return {
        at: o.mergedAt,
        sha: o.mergeSha ?? null,
        ci: o.ci ?? null,
        followUps,
        followUpCount: followUps.length,
        fixes: followUps.filter(f => f.fix).length,
        reverted: o.reverted ? { sha: o.reverted.sha, subject: o.reverted.subject } : null,
        settled: o.settled,
        author: o.author || null,
        source: 'outcomes',
    };
}

export function stateOf(pr: number | null, merge: Merge | null): PullState {
    if (pr === null) return 'not-opened';
    if (merge?.reverted) return 'reverted';
    return merge ? 'merged' : 'open';
}

/** The distinct lessons the judges found repeated, across every round. */
export function appliedLessons(rounds: Round[]): Array<{ id: string; text: string | null }> {
    const byId = new Map<string, { id: string; text: string | null }>();
    for (const r of rounds) for (const l of r.lessons.applied) byId.set(l.id, l);
    return [...byId.values()];
}

/**
 * Blocking problems found before the merge: the distinct blocking items of the records (a later round carries an
 * earlier one's items, so rounds are not added up); where no record was found, the largest count one round reported.
 */
export function blockingBeforeMerge(rounds: Round[], mergedAt: string | null): number {
    const before = rounds.filter(r => !mergedAt || r.at <= mergedAt);
    const ids = new Set(before.flatMap(r => r.blockingIds));
    const unrecorded = Math.max(0, ...before.filter(r => !r.recorded).map(r => r.blocking));
    return Math.max(ids.size, unrecorded);
}
