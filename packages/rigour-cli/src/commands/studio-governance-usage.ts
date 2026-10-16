/**
 * Governance reviewer usage and team: what the model reviewer ran in the last 28 days (runs per day from its spend
 * log, each judge and model from the review records, tokens from the verdicts, deep runs with your own key), with
 * dollars only where a judge reported them; and whether this clone shares decisions with a team.
 *
 * The task threads' `review` events (what This week and Pull requests count) fill in what the spend log and the
 * records lack: a day's runs are the larger of the two counts, and a review with no record on this machine adds its
 * judges by name, with its reported dollars where one judge ran it. A review with a record is counted once, from it.
 */
import fs from 'fs';
import path from 'path';
import { decidesTeammatesCandidates, schemaNote, type Config, type DeepRun, type TeamAccess, type TeamDecisionCache, type ThreadEvent } from '@rigour-labs/core';
import { jsonLines, readJsonFile } from './studio-files.js';

const WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

export interface JudgeUsage {
    reviewer: string;
    model: string | null;
    version: string | null;
    reviews: number;
    /** Dollars the judge reported, summed over the reviews that reported any; null when none did. */
    costUsd: number | null;
    pricedReviews: number;
    tokens: { input: number; output: number } | null;
}

export interface ReviewerUsage {
    days: Array<{ day: string; runs: number; usd: number | null }>;
    runs: number;
    judges: JudgeUsage[];
    /** Deep reviews with this person's own key (deep-runs.jsonl); null when none ran in the window. */
    deep: { runs: number; costUsd: number | null; unpricedRuns: number; inputTokens: number; outputTokens: number; models: string[] } | null;
    caps: { runsPerDay: number | null; usdPerDay: number | null; usdPerReview: number | null };
}

export interface TeamState {
    sync: boolean;
    organization: string | null;
    team: string | null;
    actor: string | null;
    /** From the last sync: whether this clone sends its person's decisions, and if not, why. */
    sharing: TeamDecisionCache['sharing'] | null;
    received: number;
    /** What this person sees of teammates' candidates, from the last team sync; null leaves the card's general line. */
    candidates: string | null;
    /** Changes the team database refused (row-level security, a constraint) or did not apply (it held a newer version) in the last 28 days, with the latest reason. */
    refused?: { count: number; latest?: string };
}

interface RecordJudge { reviewer: string; version?: string; model?: string; cost_usd?: number }
interface RecordFile { at: string; head?: string; judges?: RecordJudge[] }
/** A thread's review event, as the reviewer appends it. */
interface ReviewEvent { at: string; head?: string; judges?: unknown; cost_usd?: unknown }
interface VerdictTokens { reviewer?: string; tokens?: { input?: number; output?: number }; reviewers?: Array<{ reviewer: string; tokens?: { input?: number; output?: number } }> }

export function reviewerUsage(store: string | undefined, deepRuns: DeepRun[], config: Config, now: Date, threads: ThreadEvent[] = []): ReviewerUsage {
    const within = (at: string) => now.getTime() - Date.parse(at) <= WINDOW_MS && Date.parse(at) <= now.getTime();
    const reviews = (threads as unknown as ReviewEvent[]).filter(e => (e as { kind?: string }).kind === 'review' && typeof e.at === 'string' && within(e.at) && ranJudges(e));
    const days = withThreadDays(store ? spendDays(path.join(store, 'spend'), within) : [], reviews);
    const deep = deepRuns.filter(r => within(r.at));
    const caps = (config.review as { reviewer?: { max_runs_per_day?: number; max_usd_per_day?: number; max_usd_per_review?: number } } | undefined)?.reviewer;
    const byJudge = new Map<string, JudgeUsage>();
    const recorded = store ? judgeUsage(store, within, now.getTime() - WINDOW_MS, byJudge) : new Set<string>();
    for (const review of reviews.filter(r => !(r.head && recorded.has(r.head)))) addThreadJudges(byJudge, review);
    return {
        days,
        runs: days.reduce((n, d) => n + d.runs, 0),
        judges: [...byJudge.values()].sort((a, b) => b.reviews - a.reviews),
        deep: deep.length ? deepUsage(deep) : null,
        caps: { runsPerDay: caps?.max_runs_per_day ?? null, usdPerDay: caps?.max_usd_per_day ?? null, usdPerReview: caps?.max_usd_per_review ?? null },
    };
}

function spendDays(dir: string, within: (at: string) => boolean): ReviewerUsage['days'] {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { return []; }
    return files.map(f => f.slice(0, 10)).filter(day => within(`${day}T12:00:00`)).sort().map(day => {
        const lines = jsonLines<{ runs?: number; usd?: number }>(path.join(dir, `${day}.jsonl`));
        const priced = lines.filter(l => typeof l.usd === 'number');
        return { day, runs: lines.reduce((n, l) => n + (Number(l.runs) || 0), 0), usd: priced.length ? priced.reduce((n, l) => n + (l.usd ?? 0), 0) : null };
    });
}

/** A review event that ran the reviewer: it names judges or reports a cost (one that could not run names neither). */
function ranJudges(e: ReviewEvent): boolean {
    return (Array.isArray(e.judges) && e.judges.some(j => typeof j === 'string')) || typeof e.cost_usd === 'number';
}

/** The local calendar day, exactly as the reviewer names its spend files (core review/reviewer/store.ts localDay). */
function localDay(at: Date): string {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** Each day's runs: the spend log's count, or the threads' review events where they count more (no spend log, say). */
function withThreadDays(spend: ReviewerUsage['days'], reviews: ReviewEvent[]): ReviewerUsage['days'] {
    const byDay = new Map(spend.map(d => [d.day, { ...d }]));
    const threadDays = new Map<string, { runs: number; usd: number | null }>();
    for (const r of reviews) {
        const day = localDay(new Date(r.at));
        const t = threadDays.get(day) ?? { runs: 0, usd: null };
        t.runs++;
        if (typeof r.cost_usd === 'number') t.usd = (t.usd ?? 0) + r.cost_usd;
        threadDays.set(day, t);
    }
    for (const [day, t] of threadDays) {
        const d = byDay.get(day);
        if (!d) byDay.set(day, { day, runs: t.runs, usd: t.usd });
        else if (t.runs > d.runs) byDay.set(day, { day, runs: t.runs, usd: d.usd ?? t.usd });
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** A review no record on this machine covers: its judges by name, model not recorded, its dollars where one judge ran it. */
function addThreadJudges(byJudge: Map<string, JudgeUsage>, review: ReviewEvent): void {
    const judges = Array.isArray(review.judges) ? review.judges.filter((j): j is string => typeof j === 'string') : [];
    for (const reviewer of judges) {
        addJudge(byJudge, { reviewer, ...(judges.length === 1 && typeof review.cost_usd === 'number' ? { cost_usd: review.cost_usd } : {}) }, null);
    }
}

/**
 * Each judge and model across the review records in the window, into `byJudge`; tokens from each record's verdict,
 * where it kept them. Returns the heads those records reviewed, so a thread's event for the same review is not counted twice.
 */
function judgeUsage(store: string, within: (at: string) => boolean, since: number, byJudge: Map<string, JudgeUsage>): Set<string> {
    const heads = new Set<string>();
    let files: string[] = [];
    try { files = fs.readdirSync(store).filter(f => f.endsWith('.record.json')); } catch { return heads; }
    // A record is written once, when its review runs: one last written before the window began is not in it.
    for (const file of files.filter(f => writtenSince(path.join(store, f), since))) {
        const record = readJsonFile<RecordFile>(path.join(store, file));
        if (!record || typeof record.at !== 'string' || !within(record.at)) continue;
        const verdict = readJsonFile<VerdictTokens>(path.join(store, file.replace(/\.record\.json$/, '.json')));
        const judges = Array.isArray(record.judges) ? record.judges.filter(j => typeof j?.reviewer === 'string') : [];
        for (const judge of judges) addJudge(byJudge, judge, tokensOf(verdict, judge.reviewer));
        heads.add(typeof record.head === 'string' ? record.head : file.split('.')[0]);
    }
    return heads;
}

function writtenSince(file: string, since: number): boolean {
    try {
        return fs.statSync(file).mtimeMs >= since;
    } catch {
        return false;
    }
}

function addJudge(byJudge: Map<string, JudgeUsage>, judge: RecordJudge, tokens: { input: number; output: number } | null): void {
    const key = `${judge.reviewer}\u0000${judge.model ?? ''}`;
    const u = byJudge.get(key) ?? { reviewer: judge.reviewer, model: judge.model ?? null, version: judge.version ?? null, reviews: 0, costUsd: null, pricedReviews: 0, tokens: null };
    u.reviews++;
    if (typeof judge.cost_usd === 'number') {
        u.costUsd = (u.costUsd ?? 0) + judge.cost_usd;
        u.pricedReviews++;
    }
    if (tokens) u.tokens = { input: (u.tokens?.input ?? 0) + tokens.input, output: (u.tokens?.output ?? 0) + tokens.output };
    byJudge.set(key, u);
}

function tokensOf(verdict: VerdictTokens | undefined, reviewer: string): { input: number; output: number } | null {
    const t = (Array.isArray(verdict?.reviewers) ? verdict.reviewers : []).find(r => r?.reviewer === reviewer)?.tokens ?? (verdict?.reviewer === reviewer ? verdict.tokens : undefined);
    return t && (typeof t.input === 'number' || typeof t.output === 'number') ? { input: t.input ?? 0, output: t.output ?? 0 } : null;
}

function deepUsage(runs: DeepRun[]): NonNullable<ReviewerUsage['deep']> {
    const priced = runs.filter(r => typeof r.cost_usd === 'number');
    return {
        runs: runs.length,
        costUsd: priced.length ? priced.reduce((n, r) => n + (r.cost_usd ?? 0), 0) : null,
        unpricedRuns: runs.length - priced.length,
        inputTokens: runs.reduce((n, r) => n + (r.input_tokens ?? 0), 0),
        outputTokens: runs.reduce((n, r) => n + (r.output_tokens ?? 0), 0),
        models: [...new Set(runs.map(r => r.model).filter((m): m is string => !!m))],
    };
}

export function teamState(config: { organizationId: string; teamId: string; actorId: string } | null, cache: TeamDecisionCache | undefined, access?: TeamAccess, refused?: TeamState['refused']): TeamState {
    return {
        sync: !!config,
        organization: config?.organizationId ?? null,
        team: config?.teamId ?? null,
        actor: config?.actorId ?? null,
        sharing: cache?.sharing ?? null,
        received: cache?.decisions.length ?? 0,
        candidates: config ? candidatesLine(access) : null,
        ...(config && refused?.count ? { refused } : {}),
    };
}

/** Every member's candidates for an sme or owner where the database allows it; what an owner runs where it does not yet. */
function candidatesLine(access: TeamAccess | undefined): string | null {
    if (!access) return null;
    const note = schemaNote(access);
    if (note) return `Teammates' candidates are visible only to them until shared. ${note}`;
    return decidesTeammatesCandidates(access) ? 'As an sme or owner, you see every member\'s team candidates and share or drop them in Memory.' : null;
}
