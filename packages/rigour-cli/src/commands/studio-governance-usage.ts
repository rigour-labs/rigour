/**
 * Governance reviewer usage and team: what the model reviewer ran in the last 28 days (runs per day from its spend
 * log, each judge and model from the review records, tokens from the verdicts, deep runs with your own key), with
 * dollars only where a judge reported them; and whether this clone shares decisions with a team.
 */
import fs from 'fs';
import path from 'path';
import { TEAM_SCHEMA_UPGRADE, decidesTeammatesCandidates, needsSchemaUpgrade, type Config, type DeepRun, type TeamAccess, type TeamDecisionCache } from '@rigour-labs/core';
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
    /** Changes the team database refused in the last 28 days (row-level security, a constraint), with the latest reason. */
    refused?: { count: number; latest?: string };
}

interface RecordJudge { reviewer: string; version?: string; model?: string; cost_usd?: number }
interface RecordFile { at: string; judges?: RecordJudge[] }
interface VerdictTokens { reviewer?: string; tokens?: { input?: number; output?: number }; reviewers?: Array<{ reviewer: string; tokens?: { input?: number; output?: number } }> }

export function reviewerUsage(store: string | undefined, deepRuns: DeepRun[], config: Config, now: Date): ReviewerUsage {
    const within = (at: string) => now.getTime() - Date.parse(at) <= WINDOW_MS && Date.parse(at) <= now.getTime();
    const days = store ? spendDays(path.join(store, 'spend'), within) : [];
    const deep = deepRuns.filter(r => within(r.at));
    const caps = (config.review as { reviewer?: { max_runs_per_day?: number; max_usd_per_day?: number; max_usd_per_review?: number } } | undefined)?.reviewer;
    return {
        days,
        runs: days.reduce((n, d) => n + d.runs, 0),
        judges: store ? judgeUsage(store, within, now.getTime() - WINDOW_MS) : [],
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

/** Each judge and model across the review records in the window; tokens from each record's verdict, where it kept them. */
function judgeUsage(store: string, within: (at: string) => boolean, since: number): JudgeUsage[] {
    let files: string[] = [];
    try { files = fs.readdirSync(store).filter(f => f.endsWith('.record.json')); } catch { return []; }
    const byJudge = new Map<string, JudgeUsage>();
    // A record is written once, when its review runs: one last written before the window began is not in it.
    for (const file of files.filter(f => writtenSince(path.join(store, f), since))) {
        const record = readJsonFile<RecordFile>(path.join(store, file));
        if (!record || typeof record.at !== 'string' || !within(record.at)) continue;
        const verdict = readJsonFile<VerdictTokens>(path.join(store, file.replace(/\.record\.json$/, '.json')));
        const judges = Array.isArray(record.judges) ? record.judges.filter(j => typeof j?.reviewer === 'string') : [];
        for (const judge of judges) addJudge(byJudge, judge, tokensOf(verdict, judge.reviewer));
    }
    return [...byJudge.values()].sort((a, b) => b.reviews - a.reviews);
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
    if (needsSchemaUpgrade(access)) return `Teammates' candidates are visible only to them until shared. ${TEAM_SCHEMA_UPGRADE}`;
    return decidesTeammatesCandidates(access) ? 'As an sme or owner, you see every member\'s team candidates and share or drop them in Memory.' : null;
}
