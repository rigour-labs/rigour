/**
 * One pull request from its first recorded event to its merge, as the Pull requests page walks it: briefed, checked
 * while writing, the agent's "done", the push, Rigour's review rounds, people's review, and what happened after the
 * merge. A step this machine has no event for is null; the page says how to record it.
 */
import type { ReviewLesson, ThreadEvent } from '@rigour-labs/core';
import { recordedAgent } from './studio-agents.js';
import { num, short, strings } from './studio-pulls-data.js';
import { appliedLessons, mergeOf, roundsOf, stateOf, type Context, type Merge, type PullState, type ReportedCost, type Round } from './studio-pulls-rounds.js';

export interface HumanPoint { lesson: string; text: string; author: string; source: 'person' | 'bot' | null; state: ReviewLesson['state']; at: string | null }

export interface PullDetail {
    found: true;
    key: string;
    pr: number | null;
    title: string | null;
    branches: string[];
    state: PullState;
    firstAt: string;
    lastAt: string;
    steps: {
        brief: { at: string; count: number; items: number; agents: string[] } | null;
        edits: { at: string; checks: number; findings: number; files: number; flagged: number; cleaned: number; agents: string[] } | null;
        stop: { at: string; count: number; blocked: number; clean: number; agents: string[] } | null;
        push: { at: string; count: number; passed: number; failed: number } | null;
        reviews: Round[];
        human: { reviews: number | null; points: HumanPoint[] };
        merge: Merge | null;
    };
    facts: {
        /** Edit-check findings, stops held and pushes held before the first review round. */
        caughtBeforeReview: { findings: number; stops: number; pushes: number } | null;
        repeats: Array<{ id: string; text: string | null }>;
        rounds: number;
        durationMs: number | null;
        judges: Array<{ reviewer: string; model: string | null; version: string | null; runs: number }>;
        /** Dollars only as a judge reported them, summed per judge and basis; empty when none was reported. */
        cost: ReportedCost[];
    };
}

export function buildDetail(key: string, pr: number | null, events: ThreadEvent[], ctx: Context): PullDetail {
    const rounds = roundsOf(events, ctx);
    const merge = mergeOf(pr, events, ctx);
    const firstAt = events[0].at;
    return {
        found: true,
        key,
        pr,
        title: [...events].reverse().map(e => e.pr_title).find((t): t is string => typeof t === 'string') ?? null,
        branches: [...new Set(events.map(e => e.branch))],
        state: stateOf(pr, merge),
        firstAt,
        lastAt: events[events.length - 1].at,
        steps: {
            brief: briefStep(events), edits: editStep(events), stop: stopStep(events), push: pushStep(events),
            reviews: rounds,
            human: { reviews: humanReviews(rounds), points: pr === null ? [] : humanPoints(pr, ctx) },
            merge,
        },
        facts: {
            caughtBeforeReview: caught(events),
            repeats: appliedLessons(rounds),
            rounds: rounds.length,
            durationMs: merge ? Math.max(0, Date.parse(merge.at) - Date.parse(firstAt)) : null,
            judges: judgeRuns(rounds),
            cost: costTotals(rounds),
        },
    };
}

const ofKind = (events: ThreadEvent[], kind: ThreadEvent['kind']) => events.filter(e => e.kind === kind);

/** Agents only as the events recorded them; none recorded is an empty list, never a guess. */
function agentsOf(events: ThreadEvent[]): string[] {
    return [...new Set(events.map(e => recordedAgent(e.agent)).filter((a): a is string => a !== null))];
}

function briefStep(events: ThreadEvent[]): PullDetail['steps']['brief'] {
    const briefs = ofKind(events, 'brief');
    return briefs.length ? { at: briefs[0].at, count: briefs.length, items: briefs.reduce((n, e) => n + num(e.items), 0), agents: agentsOf(briefs) } : null;
}

function editStep(events: ThreadEvent[]): PullDetail['steps']['edits'] {
    const checks = ofKind(events, 'edit-check');
    if (!checks.length) return null;
    const files = new Set<string>();
    const flagged = new Set<string>();
    const cleaned = new Set<string>();
    for (const e of checks) {
        const touched = strings(e.files);
        touched.forEach(f => files.add(f));
        if (num(e.findings) > 0) touched.forEach(f => flagged.add(f));
        else touched.filter(f => flagged.has(f)).forEach(f => cleaned.add(f));
    }
    return { at: checks[0].at, checks: checks.length, findings: checks.reduce((n, e) => n + num(e.findings), 0), files: files.size, flagged: flagged.size, cleaned: cleaned.size, agents: agentsOf(checks) };
}

function stopStep(events: ThreadEvent[]): PullDetail['steps']['stop'] {
    const stops = ofKind(events, 'stop-review');
    const blocked = stops.filter(e => e.blocked === true).length;
    return stops.length ? { at: stops[0].at, count: stops.length, blocked, clean: stops.length - blocked, agents: agentsOf(stops) } : null;
}

function pushStep(events: ThreadEvent[]): PullDetail['steps']['push'] {
    const pushes = ofKind(events, 'push');
    const failed = pushes.filter(e => e.passed === false).length;
    return pushes.length ? { at: pushes[0].at, count: pushes.length, passed: pushes.length - failed, failed } : null;
}

/** What Rigour stopped before its first review round: null when no edit check, stop or push was recorded before it. */
function caught(events: ThreadEvent[]): PullDetail['facts']['caughtBeforeReview'] {
    const firstReview = events.find(e => e.kind === 'review')?.at;
    const before = firstReview ? events.filter(e => e.at < firstReview) : events;
    if (!before.some(e => e.kind === 'edit-check' || e.kind === 'stop-review' || e.kind === 'push')) return null;
    return {
        findings: ofKind(before, 'edit-check').reduce((n, e) => n + num(e.findings), 0),
        stops: ofKind(before, 'stop-review').filter(e => e.blocked === true).length,
        pushes: ofKind(before, 'push').filter(e => e.passed === false).length,
    };
}

/** People's reviews the reviewer read, as its records reported them: the most any round saw. */
function humanReviews(rounds: Round[]): number | null {
    const seen = rounds.map(r => r.humanReviews).filter((n): n is number => n !== null);
    return seen.length ? Math.max(...seen) : null;
}

/** Review points made on this pull request that became lessons, with who made each. */
function humanPoints(pr: number, ctx: Context): HumanPoint[] {
    return [...ctx.lessons.values()].flatMap(lesson => lesson.evidence
        .filter(e => e.pr === pr && (e.kind ?? 'point') === 'point')
        .map(e => ({ lesson: short(lesson.text, 160), text: short(e.text ?? e.comment ?? '', 200), author: e.author, source: e.source ?? null, state: lesson.state, at: e.postedAt ?? e.at ?? null })))
        .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
        .slice(0, 30);
}

function judgeRuns(rounds: Round[]): PullDetail['facts']['judges'] {
    const byKey = new Map<string, PullDetail['facts']['judges'][number]>();
    for (const j of rounds.flatMap(r => r.judges)) {
        const key = `${j.reviewer}\0${j.model ?? ''}`;
        const known = byKey.get(key);
        byKey.set(key, known ? { ...known, runs: known.runs + 1 } : { ...j, runs: 1 });
    }
    return [...byKey.values()];
}

function costTotals(rounds: Round[]): ReportedCost[] {
    const byKey = new Map<string, ReportedCost>();
    for (const c of rounds.flatMap(r => r.cost)) {
        const key = `${c.by}\0${c.basis}`;
        byKey.set(key, { ...c, usd: (byKey.get(key)?.usd ?? 0) + c.usd });
    }
    return [...byKey.values()];
}
