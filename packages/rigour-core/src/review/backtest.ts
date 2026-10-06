/**
 * Backtest: run the review on a commit a person reviewed, with that review hidden, and score what
 * Rigour reports against the points the person made. The ledger (`.rigour/backtest.json`) holds,
 * per round, the reviewed commit, the base it was reviewed against, when the review was posted,
 * the reviewer's points (each a file pattern plus a line window or a text pattern) and code the
 * reviewer called good (a blocking finding there is a false block).
 *
 * A point counts as caught only when a BLOCKING finding matches it. A match in an advisory note
 * is shown as "noted" and still counted as missed: nothing advisory stops a push. Each round runs
 * in a detached worktree under the git directory, so the repository and its branches stay as they
 * are, and the findings reported are kept beside the score so a pattern can be checked.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { Config, Failure } from '../types/index.js';
import { reviewChange } from './review.js';
import { defaultExec, runReviewer, type Exec, type OpenItem, type Progress } from './reviewer.js';
import { reviewerInputs } from './reviewer/context.js';
import { formatJudges, judgedFrom, type JudgeCatches, type JudgeRun } from './backtest-judges.js';

const Match = z.object({
    /** A regular expression over the finding's file path. */
    file: z.string(),
    /** A line window at the reviewed commit: a finding inside it matches. */
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    /** A regular expression over the finding's text; the alternative for a point with no line. */
    text: z.string().optional(),
    /** Left by `rigour backtest init` on a row a person still has to complete. */
    needs: z.string().optional(),
});
const Point = Match.extend({ id: z.string().min(1), point: z.string().min(1) });
const Round = z.object({
    id: z.string().min(1),
    commit: z.string().min(7),
    base: z.string().min(1),
    /** When the human review was posted: the reviewer sees nothing from then on. */
    reviewed_at: z.string().optional(),
    pr: z.number().int().positive().optional(),
    points: z.array(Point),
    must_not_flag: z.array(Match).default([]),
});
export const LedgerSchema = z.object({ rounds: z.array(Round).min(1) });
export type Ledger = z.infer<typeof LedgerSchema>;
export type LedgerRound = z.infer<typeof Round>;
export type LedgerPoint = z.infer<typeof Point>;
type LedgerMatch = z.infer<typeof Match>;

export const LEDGER_PATH = '.rigour/backtest.json';

/** A finding as the score sees it, from a gate or the reviewer. */
export interface BacktestItem { gate: string; file: string; line: number | undefined; text: string; blocking: boolean }

export interface PointOutcome extends Pick<LedgerPoint, 'id' | 'point'> {
    caught: boolean;
    /** Matched by an advisory note only: visible, but it would not have stopped the push. */
    noted: boolean;
    by?: string;
}
export interface RoundResult {
    round: string;
    head: string;
    base: string;
    points: PointOutcome[];
    falseBlocks: BacktestItem[];
    items: BacktestItem[];
    durationMs: number;
    /** Why the reviewer gave no verdict, when it ran. */
    reviewerError?: string;
    /** With two or more judges: the ledger points each raised on its own, and the round's runs and cost. */
    judges?: JudgeCatches;
}

export interface BacktestOptions {
    round?: string;
    reviewer?: boolean;
    exec?: Exec;
    progress?: Progress;
    /** Produces the findings for a worktree; tests replace it. */
    collect?: (worktree: string, round: LedgerRound, config: Config) => Promise<Collected>;
}

export function loadLedger(cwd: string): Ledger {
    const file = path.join(cwd, LEDGER_PATH);
    if (!fs.existsSync(file)) throw new Error(`no ledger at ${LEDGER_PATH}: run \`rigour backtest init --pr <number>\` or write one (docs/BACKTEST.md)`);
    const parsed = LedgerSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`${LEDGER_PATH} is not a ledger: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const problems = ledgerProblems(parsed.data);
    if (problems.length) throw new Error(`${LEDGER_PATH} has rows a person still has to complete:\n  ${problems.join('\n  ')}`);
    return parsed.data;
}

/** Rows that cannot match anything: no file pattern, neither a line window nor a text pattern, or a scaffold mark. */
export function ledgerProblems(ledger: Ledger): string[] {
    const problems: string[] = [];
    for (const round of ledger.rounds) {
        const rows: Array<[string, LedgerMatch]> = [...round.points.map((p): [string, LedgerMatch] => [p.id, p]), ...round.must_not_flag.map((m, i): [string, LedgerMatch] => [`must_not_flag[${i}]`, m])];
        for (const [name, row] of rows) {
            if (row.needs) problems.push(`${round.id} ${name}: needs ${row.needs}`);
            else if (!row.file) problems.push(`${round.id} ${name}: no file pattern`);
            else if (!row.lines && !row.text) problems.push(`${round.id} ${name}: needs a line window or a text pattern`);
            else if (!valid(row.file) || (row.text !== undefined && !valid(row.text))) problems.push(`${round.id} ${name}: not a regular expression`);
        }
    }
    return problems;
}

function valid(pattern: string): boolean {
    try {
        new RegExp(pattern, 'i');
        return true;
    } catch {
        return false;
    }
}

export async function runBacktest(cwd: string, config: Config, ledger: Ledger, options: BacktestOptions = {}): Promise<RoundResult[]> {
    const rounds = options.round ? ledger.rounds.filter(r => r.id === options.round) : ledger.rounds;
    if (rounds.length === 0) throw new Error(`no round "${options.round}" in ${LEDGER_PATH}: ${ledger.rounds.map(r => r.id).join(', ')}`);
    const exec = options.exec ?? defaultExec;
    const progress = options.progress ?? (() => undefined);
    const results: RoundResult[] = [];
    for (const round of rounds) {
        const started = Date.now();
        const worktree = await worktreeFor(cwd, round.commit, exec);
        const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: worktree, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
        progress(`backtest ${round.id}: ${head.slice(0, 9)} against ${round.base}${round.reviewed_at ? `, reviews hidden from ${round.reviewed_at}` : ''}`);
        const collect = options.collect ?? ((tree, r, c) => collectItems(tree, r, c, !!options.reviewer, exec, progress));
        const { items, reviewerError, judged } = await collect(worktree, round, config);
        const result = { ...score(round, head, items, Date.now() - started, reviewerError), ...(judged ? { judges: judgeCatches(round, judged) } : {}) };
        record(cwd, result);
        results.push(result);
    }
    return results;
}

/** Every point caught, nothing the reviewer called good flagged, and a verdict when the reviewer ran. */
export function backtestPassed(results: RoundResult[]): boolean {
    return results.every(r => r.points.every(p => p.caught) && r.falseBlocks.length === 0 && !r.reviewerError);
}

export function score(round: LedgerRound, head: string, items: BacktestItem[], durationMs: number, reviewerError: string | undefined): RoundResult {
    const points = round.points.map(point => {
        const hit = items.find(item => item.blocking && matches(point, item));
        const noted = !hit && items.some(item => !item.blocking && matches(point, item));
        return { id: point.id, point: point.point, caught: !!hit, noted, ...(hit ? { by: `${hit.gate} ${hit.file}${hit.line ? `:${hit.line}` : ''}` } : {}) };
    });
    const falseBlocks = items.filter(item => item.blocking && round.must_not_flag.some(guard => matches(guard, item)));
    return { round: round.id, head, base: round.base, points, falseBlocks, items, durationMs, ...(reviewerError ? { reviewerError } : {}) };
}

/** The file pattern must match, then either the line window holds the finding's line or the text pattern matches its text. */
function matches(row: LedgerMatch, item: BacktestItem): boolean {
    if (!new RegExp(row.file, 'i').test(item.file)) return false;
    const inWindow = !!row.lines && item.line !== undefined && item.line >= row.lines[0] && item.line <= row.lines[1];
    const inText = row.text !== undefined && new RegExp(row.text, 'i').test(item.text);
    return inWindow || inText;
}

const GIT_TIMEOUT_MS = 60_000;

/** A detached worktree at the commit, under the git directory (shared by worktrees), reused on the next run. */
async function worktreeFor(cwd: string, commit: string, exec: Exec): Promise<string> {
    const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: GIT_TIMEOUT_MS })).stdout.trim();
    if (!common) throw new Error(`${cwd} is not a git repository`);
    const resolved = await exec('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (resolved.exitCode !== 0) {
        const reason = resolved.stderr.trim().split('\n').at(-1);
        throw new Error(`commit ${commit} is not in this repository (fetch the branch it was reviewed on)${reason ? `: git said "${reason}"` : ''}`);
    }
    const dir = path.join(common, 'rigour-backtest', resolved.stdout.trim().slice(0, 12));
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        const added = await exec('git', ['worktree', 'add', '--detach', dir, resolved.stdout.trim()], { cwd, timeoutMs: 5 * GIT_TIMEOUT_MS });
        if (added.exitCode !== 0) throw new Error(`could not check out ${commit} for the backtest: ${added.stderr.trim()}`);
    }
    shareDependencies(cwd, dir);
    return dir;
}

/** The checkout's installed dependencies serve the worktree too (the typed checks need the project's compiler), never a download. */
function shareDependencies(cwd: string, worktree: string): void {
    const root = path.join(cwd, 'node_modules');
    if (fs.existsSync(root) && !fs.existsSync(path.join(worktree, 'node_modules'))) fs.symlinkSync(root, path.join(worktree, 'node_modules'), 'junction');
}

interface Collected { items: BacktestItem[]; reviewerError?: string; judged?: JudgeRun }

/** Which ledger points each judge raised itself, matched the way the score matches any finding. */
function judgeCatches(round: LedgerRound, judged: JudgeRun): JudgeCatches {
    const caught = Object.fromEntries(judged.judges.map(judge => [judge, round.points.filter(point => judged.raised.some(r => r.judge === judge && matches(point, { gate: `judge:${judge}`, file: r.file, line: r.line, text: r.text, blocking: true }))).map(p => p.id)]));
    return { judges: judged.judges, caught, points: round.points.map(p => p.id), runs: judged.runs, ...(judged.costUsd !== undefined ? { costUsd: judged.costUsd } : {}) };
}

async function collectItems(worktree: string, round: LedgerRound, config: Config, reviewer: boolean, exec: Exec, progress: Progress): Promise<Collected> {
    const review = await reviewChange({ cwd: worktree, config, source: { mode: 'base', base: round.base }, typed: true });
    const items = [
        ...review.findings.map(f => asItem(f, true)),
        ...[...review.advisory, ...review.contextFindings].map(f => asItem(f, false)),
    ];
    if (!reviewer) return { items };
    const result = await runReviewer(worktree, round.base, config, exec, progress, { pr: round.pr, reviewsBefore: round.reviewed_at, trigger: 'backtest', force: true, ...reviewerInputs(review) });
    if (result.outcome === 'unavailable' || result.outcome === 'skipped') return { items, reviewerError: result.reason ?? result.outcome };
    // The reviewer behind each catch is part of the score, so the gate is `reviewer:<name>`.
    const asReviewerItem = (item: OpenItem, blocking: boolean): BacktestItem => ({ gate: `reviewer:${item.reviewer ?? result.reviewers[0]}`, file: item.file ?? '', line: item.line, text: [item.issue, item.consequence, item.evidence].filter(Boolean).join(' '), blocking });
    items.push(...result.items.map(i => asReviewerItem(i, true)), ...[...result.unverified, ...result.notes, ...result.disputed].map(i => asReviewerItem(i, false)));
    const judged = judgedFrom(result);
    return { items, ...(judged ? { judged } : {}) };
}

function asItem(failure: Failure, blocking: boolean): BacktestItem {
    return { gate: failure.id, file: failure.files?.[0] ?? '', line: failure.line, text: [failure.title, failure.details, failure.hint].filter(Boolean).join(' '), blocking };
}

/** The score and every item reported, beside the worktrees, so a pattern that missed can be checked against what was there. */
function record(cwd: string, result: RoundResult): void {
    try {
        const dir = path.join(cwd, '.rigour', 'backtest');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${result.round}-${result.head.slice(0, 12)}.json`), JSON.stringify(result, null, 2));
    } catch {
        // the score is printed either way
    }
}

export function formatBacktest(results: RoundResult[]): string {
    const lines: string[] = [];
    for (const r of results) {
        const caught = r.points.filter(p => p.caught).length;
        lines.push(`${r.round} at ${r.head.slice(0, 9)}: ${caught}/${r.points.length} caught, ${r.falseBlocks.length} false block(s), ${r.items.length} finding(s), ${Math.round(r.durationMs / 1000)}s${byGate(r)}`);
        for (const p of r.points) lines.push(`  ${p.caught ? 'caught ' : p.noted ? 'noted  ' : 'MISSED '} ${p.id} ${p.point}${p.by ? ` (${p.by})` : p.noted ? ' (advisory only)' : ''}`);
        for (const f of r.falseBlocks) lines.push(`  FALSE   ${f.gate} ${f.file}${f.line ? `:${f.line}` : ''} ${f.text.slice(0, 100)}`);
        if (r.reviewerError) lines.push(`  NO VERDICT ${r.reviewerError}`);
    }
    return lines.join('\n') + formatJudges(results);
}

/** Which gate (or the reviewer) caught what: `; caught by unused-export 2, reviewer 1`, so a rule is judged on its own rows. */
function byGate(result: RoundResult): string {
    const counts = new Map<string, number>();
    for (const p of result.points) if (p.by) counts.set(p.by.split(' ')[0], (counts.get(p.by.split(' ')[0]) ?? 0) + 1);
    return counts.size ? `; caught by ${[...counts].map(([gate, n]) => `${gate} ${n}`).join(', ')}` : '';
}
