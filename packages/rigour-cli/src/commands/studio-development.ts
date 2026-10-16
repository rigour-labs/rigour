/**
 * Studio's "While writing": what Rigour did while agents wrote code, before any pull request. The four moments an agent
 * passes through (briefed, each edit checked, the stop review when it says done, the push), what was caught on the way,
 * what the agent fixed and how fast, and what is still open. Read-only; every number is counted from what Rigour recorded
 * (task threads, each checkout's events.jsonl, stories.jsonl, agent-fixes/open.json). How a check recorded in both a
 * thread and events.jsonl is counted once: studio-development-parts.ts.
 */
import { threadsDir, type AgentEvent, type CatchStage, type Story } from '@rigour-labs/core';
import { aboutAnotherRepository } from './studio-activity.js';
import { checkoutRoots, eventsAcross, openFindingsAcross, storiesAcross } from './studio-checkouts.js';
import { buildFeed, minutesToFix, type FeedItem } from './studio-development-feed.js';
import { fromEvents, joinRecords, readThreadRecords, threadsStart, type DevRecord } from './studio-development-parts.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVELOPMENT: CatchStage[] = ['edit', 'review', 'stop'];
const TOP_RULES = 6;
const RECENT_FIXES = 20;
const OPEN_LISTED = 8;

type OpenFinding = { file: string; rule: string; title?: string; openedAt: string; stage?: CatchStage };

interface DevelopmentInputs {
    now: Date;
    days: number;
    /** Brief, edit, stop and push records from the window's start on, each check once. */
    records: DevRecord[];
    /** Lessons an agent asked for itself (recall, context, review), from the window's start on. */
    lessonsOnRequest: number;
    stories: Story[];
    open: OpenFinding[];
    recordingSince: string | null;
}

export interface AgentRow {
    /** null: the hook did not record which agent. */
    agent: string | null;
    briefings: number;
    editsChecked: number;
    editsWithFindings: number;
    stopReviews: number;
    sentBack: number;
    /** The push gate never records an agent: null on a named agent's row. */
    pushes: number | null;
}

export interface StudioDevelopment {
    window: { from: string; to: string; days: number };
    recordingSince: string | null;
    stages: {
        /** sessions: agent sessions briefed, null when no briefing recorded its session. */
        brief: { briefings: number; sessions: number | null; told: number; onRequest: number };
        edits: { checked: number; withFindings: number; blocked: number | null };
        stop: { reviews: number; blocked: number; nothingToReview: number | null; fixedBeforeDone: number };
        push: { runs: number; passed: number; failed: number };
    };
    caught: { total: number; fixedByAgent: number; stillOpen: number; medianMinutesToFix: number | null; byStage: Record<CatchStage, number> };
    topRules: Array<{ rule: string; title: string; caught: number; fixed: number }>;
    byAgent: AgentRow[];
    recentFixes: Story[];
    open: Array<{ file: string; rule: string; title: string; openedAt: string; stage: CatchStage }>;
    feed: FeedItem[];
}

function buildDevelopment(input: DevelopmentInputs): StudioDevelopment {
    const from = input.now.getTime() - input.days * DAY_MS;
    const inWindow = (at: string) => Date.parse(at) >= from && Date.parse(at) <= input.now.getTime();
    const records = input.records.filter(r => inWindow(r.at));
    const stories = input.stories.filter(s => DEVELOPMENT.includes(s.stage) && inWindow(s.at));
    const open = input.open.filter(o => DEVELOPMENT.includes(o.stage ?? 'edit') && inWindow(o.openedAt))
        .map(o => ({ ...o, title: o.title ?? o.rule, stage: o.stage ?? 'edit' }));
    return {
        window: { from: new Date(from).toISOString(), to: input.now.toISOString(), days: input.days },
        recordingSince: input.recordingSince,
        stages: stages(records, stories, input.lessonsOnRequest),
        caught: caught(stories, open),
        topRules: topRules(stories, open),
        byAgent: byAgent(records),
        recentFixes: [...stories].reverse().slice(0, RECENT_FIXES),
        open: open.slice(0, OPEN_LISTED),
        feed: buildFeed(records, stories),
    };
}

function stages(records: DevRecord[], stories: Story[], onRequest: number): StudioDevelopment['stages'] {
    const of = (stage: DevRecord['stage']) => records.filter(r => r.stage === stage);
    const [briefs, edits, stops, pushes] = [of('brief'), of('edit'), of('stop'), of('push')];
    const sessions = new Set(briefs.flatMap(b => (b.session ? [b.session] : [])));
    return {
        brief: { briefings: briefs.length, sessions: sessions.size || null, told: sum(briefs.map(b => b.count)), onRequest },
        edits: { checked: edits.length, withFindings: edits.filter(e => e.count > 0).length, blocked: known(edits, e => e.held) },
        stop: {
            reviews: stops.length, blocked: stops.filter(s => s.held).length,
            nothingToReview: known(stops, s => s.nothingToReview), fixedBeforeDone: stories.filter(s => s.stage === 'stop').length,
        },
        push: { runs: pushes.length, passed: pushes.filter(p => !p.held).length, failed: pushes.filter(p => p.held).length },
    };
}

/** How many say yes, among those that recorded it; null when none did. */
function known(records: DevRecord[], flag: (r: DevRecord) => boolean | null | undefined): number | null {
    const recorded = records.filter(r => typeof flag(r) === 'boolean');
    return recorded.length ? recorded.filter(r => flag(r)).length : null;
}

function caught(stories: Story[], open: OpenFinding[]): StudioDevelopment['caught'] {
    const byStage = { edit: 0, review: 0, stop: 0, pr: 0 } as Record<CatchStage, number>;
    for (const s of stories) byStage[s.stage]++;
    for (const o of open) byStage[o.stage ?? 'edit']++;
    const minutes = stories.map(minutesToFix).filter((m): m is number => m !== null).sort((a, b) => a - b);
    return { total: stories.length + open.length, fixedByAgent: stories.length, stillOpen: open.length, medianMinutesToFix: median(minutes), byStage };
}

/** By check; a function review's fixes are not a check, so they are left out. Ties keep the most fixed first. */
function topRules(stories: Story[], open: OpenFinding[]): StudioDevelopment['topRules'] {
    const rules = new Map<string, { rule: string; title: string; caught: number; fixed: number; last: string }>();
    const add = (rule: string, title: string, at: string, fixed: boolean) => {
        if (rule === 'review') return;
        const row = rules.get(rule) ?? { rule, title, caught: 0, fixed: 0, last: '' };
        row.caught++;
        if (fixed) row.fixed++;
        if (at >= row.last) Object.assign(row, { last: at, title });
        rules.set(rule, row);
    };
    for (const s of stories) add(s.rule, s.title, s.at, true);
    for (const o of open) add(o.rule, o.title ?? o.rule, o.openedAt, false);
    return [...rules.values()].sort((a, b) => b.caught - a.caught || b.fixed - a.fixed).slice(0, TOP_RULES)
        .map(({ rule, title, caught: n, fixed }) => ({ rule, title, caught: n, fixed }));
}

function byAgent(records: DevRecord[]): AgentRow[] {
    const rows = new Map<string | null, AgentRow>();
    const row = (agent: string | null) => rows.get(agent)
        ?? rows.set(agent, { agent, briefings: 0, editsChecked: 0, editsWithFindings: 0, stopReviews: 0, sentBack: 0, pushes: agent === null ? 0 : null }).get(agent)!;
    for (const r of records) {
        const target = row(r.stage === 'push' ? null : r.agent);
        if (r.stage === 'brief') target.briefings++;
        if (r.stage === 'edit') { target.editsChecked++; if (r.count > 0) target.editsWithFindings++; }
        if (r.stage === 'stop') { target.stopReviews++; if (r.held) target.sentBack++; }
        if (r.stage === 'push') target.pushes = (target.pushes ?? 0) + 1;
    }
    const total = (r: AgentRow) => r.briefings + r.editsChecked + r.stopReviews;
    return [...rows.values()].sort((a, b) => (a.agent === null ? 1 : 0) - (b.agent === null ? 1 : 0) || total(b) - total(a));
}

function median(sorted: number[]): number | null {
    if (!sorted.length) return null;
    const mid = sorted.length >> 1;
    return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

function sum(values: number[]): number {
    return values.reduce((n, v) => n + v, 0);
}

/** `?days=28` for four weeks; anything else is the last 7 days. */
function windowDays(url?: URL): number {
    return url?.searchParams.get('days') === '28' ? 28 : 7;
}

export function loadDevelopment(cwd: string, url?: URL, now = new Date()): StudioDevelopment {
    const days = windowDays(url);
    const since = now.getTime() - days * DAY_MS;
    const roots = checkoutRoots(cwd);
    const events = eventsAcross(roots).filter(e => !aboutAnotherRepository(e, roots));
    const dir = threadsDir(cwd);
    const stories = storiesAcross(roots);
    return buildDevelopment({
        now, days,
        records: joinRecords(readThreadRecords(dir, since), fromEvents(events, since)),
        lessonsOnRequest: onRequest(events, since),
        stories,
        open: openFindingsAcross(roots),
        recordingSince: earliest([threadsStart(dir), stories[0]?.at ?? null, events.find(e => e.timestamp)?.timestamp ?? null]),
    });
}

/** Lessons an agent asked for (recall, context, a review) rather than was briefed with. */
function onRequest(events: AgentEvent[], since: number): number {
    return sum(events.filter(e => e.type === 'lessons_served' && e.via !== 'brief' && Date.parse(e.timestamp ?? '') >= since).map(e => e.lessons?.length ?? 0));
}

function earliest(times: Array<string | null>): string | null {
    return times.filter((t): t is string => !!t && Number.isFinite(Date.parse(t))).sort()[0] ?? null;
}
