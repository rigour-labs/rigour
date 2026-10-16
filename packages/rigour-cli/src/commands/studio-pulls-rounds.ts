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

/** `no-merge`: a pull request with no merge recorded on this machine; whether it is still open is not recorded. */
export type PullState = 'not-opened' | 'no-merge' | 'merged' | 'reverted';

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

/**
 * A branch reused for a second pull request carries both in one thread: a pull request keeps the review, merge and
 * outcome events that name it, or name none.
 */
export function eventsOfPr(events: ThreadEvent[], pr: number | null): ThreadEvent[] {
    if (pr === null) return events;
    return events.filter(e => !PR_KINDS.has(e.kind) || typeof e.pr !== 'number' || e.pr === pr);
}

const PR_KINDS = new Set<ThreadEvent['kind']>(['review', 'merge', 'outcome']);

/** Each review event, oldest first, with its record when this machine keeps it. */
export function roundsOf(events: ThreadEvent[], ctx: Context): Round[] {
    return events.filter(e => e.kind === 'review').map(e => round(e, ctx));
}

function round(e: ThreadEvent, ctx: Context): Round {
    const read = ctx.record(e.head, e.integrity);
    const fields = read ? fromRecord(read) : undefined;
    return {
        at: e.at,
        head: typeof e.head === 'string' ? e.head : null,
        trigger: typeof e.trigger === 'string' ? e.trigger : null,
        outcome: typeof e.outcome === 'string' ? e.outcome : 'unknown',
        blocking: num(e.blocking),
        shouldFix: num(e.should_fix),
        judges: fields?.judges ?? strings(e.judges).map(reviewer => ({ reviewer, model: null, version: null })),
        recorded: !!fields,
        rules: fields?.rules ?? null,
        lessons: { served: fields?.lessonsServed ?? null, applied: strings(e.lessons_applied).map(id => ({ id, text: lessonText(ctx, id) })) },
        disputed: fields?.disputed ?? null,
        humanReviews: fields?.humanReviews ?? null,
        blind: fields?.blind ?? false,
        blockingIds: fields?.blockingIds ?? [],
        cost: costOf(e, fields ? read : undefined),
    };
}

type RecordFields = Pick<Round, 'judges' | 'rules' | 'disputed' | 'humanReviews' | 'blind' | 'blockingIds'> & { lessonsServed: number | null };

/**
 * What a review's record says, read defensively: a record written by another version, or damaged, can miss any part.
 * A record without its verified rules or blocking list reads as not found: the round falls back to the event's own figures.
 */
function fromRecord(read: RecordRead): RecordFields | undefined {
    const r = read.record as unknown as Partial<Record<string, unknown>>;
    const verified = obj(r.verified);
    const rules = obj(verified?.rules);
    if (!verified || !rules || !Array.isArray(verified.blocking)) return undefined;
    const blind = r.blind === true;
    return {
        judges: arr(r.judges).flatMap(j => {
            const judge = obj(j);
            return judge && typeof judge.reviewer === 'string'
                ? [{ reviewer: judge.reviewer, model: typeof judge.model === 'string' ? judge.model : null, version: typeof judge.version === 'string' ? judge.version : null }]
                : [];
        }),
        rules: { served: num(rules.served), followed: num(rules.followed), broken: num(rules.broken), notApplicable: num(rules.not_applicable), brokenNames: read.brokenRules },
        lessonsServed: nullableNum(obj(verified.lessons)?.served),
        disputed: nullableNum(verified.disputed),
        humanReviews: blind ? null : nullableNum(obj(r.reported)?.human_reviews),
        blind,
        blockingIds: arr(verified.blocking).map(i => obj(i)?.id).filter((id): id is string => typeof id === 'string'),
    };
}

function obj(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function nullableNum(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function lessonText(ctx: Context, id: string): string | null {
    const lesson = ctx.lessons.get(id);
    return lesson ? short(lesson.text, 160) : null;
}

/** What the judges reported: each judge's own figure from the record, else the review's total for its judges. */
function costOf(e: ThreadEvent, read: RecordRead | undefined): ReportedCost[] {
    const own = arr(read?.record.judges).flatMap(j => {
        const judge = obj(j);
        return judge && typeof judge.cost_usd === 'number' && Number.isFinite(judge.cost_usd) && typeof judge.reviewer === 'string'
            ? [{ usd: judge.cost_usd, by: judge.reviewer, basis: 'judge' as const }]
            : [];
    });
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
    const followUps = arr(o.followUps).filter((f): f is NonNullable<PrOutcome['followUps']>[number] => typeof obj(f)?.sha === 'string')
        .map(f => ({ sha: f.sha, at: String(f.at ?? ''), subject: short(String(f.subject ?? ''), 120), fix: f.fix === true }));
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
    return merge ? 'merged' : 'no-merge';
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
