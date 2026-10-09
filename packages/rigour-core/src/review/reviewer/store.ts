/**
 * Where verdicts live: inside the repository's git directory (the common one, so every worktree
 * of a repository shares it), never in the working tree and never through team sync, since a
 * verdict quotes code and review text. Per commit and input fingerprint: the verdict, and the
 * open items a later run or a reply refers to by id. Per branch: the last verdict and how many
 * delta reviews chain back to the last full one.
 */
import fs from 'fs';
import path from 'path';
import type { Exec } from './exec.js';
import { GH_TIMEOUT_MS } from './exec.js';

/** What the reviewer spent on one local day in this repository: agent runs, and the dollars the CLIs reported. */
export interface DaySpend { runs: number; usd: number }

/** The local calendar day, as a team's "per day" means it. */
function localDay(at = new Date()): string {
    return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

export interface ReviewAttempt { head: string; outcome: 'unavailable' | 'skipped'; reason: string; at: string }

export interface BranchState {
    head: string;
    verdict: string;
    mode: 'full' | 'delta';
    chain: number;
    rulesHash: string;
    reviewsKey: string;
    /** Everything but the commit that decides a verdict: the same commit with the same key reuses it. */
    inputsKey?: string;
    at: string;
}

/**
 * A finished review's cost, for the orchestrator's savings ledger (orchestrator.ts). Sizes are characters of what the
 * judge is given: `shared` (the input files every run reads, the diff left out) plus the reviewable diff (lockfiles and
 * generated files left out), counted the same way in both modes.
 */
export interface ReviewCost {
    at: string;
    /** `single`: one judge, asked for and run (never an orchestrator's fallback). `orchestrator`: every run it made, its fallback included. */
    mode: 'single' | 'orchestrator';
    /** Changed lines in the reviewable diff. */
    lines: number;
    /** What one judge would be given for this change: shared inputs + the reviewable diff. */
    projectedSingleChars: number;
    /** What the orchestrator planned: per pass, shared inputs + its slice (0 when no pass). Orchestrator rows only. */
    projectedChars?: number;
    /** What every run was given, a failed pass, a fallback and a retry included. */
    actualChars: number;
    /** What every run reported costing; a judge that reports no dollars adds none. */
    actualUsd: number;
    runs: number;
    /** A verdict reused instead of run: for the same content on another commit (`content`). Runs and actual cost are 0. */
    cache?: 'content';
}

/**
 * A verdict, findable by the content it reviewed rather than its commit: a rebase, an amend, a cherry-pick or the same
 * change on another branch reads it instead of paying again. `cited` is the merge-base blob of every file its items cite:
 * a later base under one of them makes the entry stale.
 */
export interface ContentEntry { verdict: string; head: string; at: string; cited: Record<string, string> }
/** Content entries kept, newest first; older ones are removed when a new one is written. */
const CONTENT_KEPT = 500;
/** A content entry older than this is not reused. */
const CONTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What one judge cost per character here, frozen once, at the orchestrator's first review: `null` without enough single reviews. */
export interface CostBaseline { at: string; usdPerChar: number | null; singles: number }
const COSTS_KEPT = 200;

export class VerdictStore {
    private constructor(private readonly dir: string) {}

    static async open(cwd: string, exec: Exec): Promise<VerdictStore | undefined> {
        const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeoutMs: GH_TIMEOUT_MS })).stdout.trim();
        if (!common) return undefined;
        const dir = path.join(common, 'rigour-reviewer');
        fs.mkdirSync(path.join(dir, 'branches'), { recursive: true });
        return new VerdictStore(dir);
    }

    /** The verdict reviewed under this content key, unless it is older than CONTENT_TTL_MS or its verdict is gone. */
    contentEntry(key: string): ContentEntry | undefined {
        const entry = this.readJson<ContentEntry>(path.join(this.dir, 'content', `${key}.json`));
        if (!entry || Date.now() - Date.parse(entry.at) > CONTENT_TTL_MS || !fs.existsSync(entry.verdict)) return undefined;
        return entry;
    }

    /** Keeps a content entry; past CONTENT_KEPT, the oldest are removed. */
    recordContent(key: string, entry: ContentEntry): void {
        const dir = path.join(this.dir, 'content');
        fs.mkdirSync(dir, { recursive: true });
        this.writeJson(path.join(dir, `${key}.json`), entry);
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        if (files.length <= CONTENT_KEPT) return;
        const byAge = files.map(f => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => a.at - b.at);
        for (const { f } of byAge.slice(0, files.length - CONTENT_KEPT)) fs.rmSync(path.join(dir, f), { force: true });
    }

    verdictPath(head: string, fingerprint: string): string {
        return path.join(this.dir, `${head}.${fingerprint.slice(0, 8)}.json`);
    }

    /** The open items beside a verdict, by id; what a delta review is asked to carry or resolve. */
    openPath(verdictPath: string): string {
        return verdictPath.replace(/\.json$/, '.open.json');
    }

    readJson<T>(file: string): T | undefined {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
        } catch {
            return undefined;
        }
    }

    writeJson(file: string, value: unknown): void {
        fs.writeFileSync(file, JSON.stringify(value, null, 2));
    }

    branchState(branch: string): BranchState | undefined {
        return this.readJson<BranchState>(this.branchFile(branch));
    }

    recordBranch(branch: string, state: Omit<BranchState, 'chain' | 'at'>): void {
        const previous = this.branchState(branch);
        this.writeJson(this.branchFile(branch), { ...state, chain: state.mode === 'delta' ? (previous?.chain ?? 0) + 1 : 0, at: new Date().toISOString() });
    }

    /** Today's spend, summed from the day's append-only log (one line per run or batch of runs). */
    spend(day = localDay()): DaySpend {
        let text = '';
        try {
            text = fs.readFileSync(this.spendFile(day), 'utf8');
        } catch {
            return { runs: 0, usd: 0 };
        }
        return text.split('\n').filter(Boolean).reduce((sum, line) => {
            try {
                const entry = JSON.parse(line);
                return { runs: sum.runs + (Number(entry.runs) || 0), usd: sum.usd + (Number(entry.usd) || 0) };
            } catch {
                return sum;
            }
        }, { runs: 0, usd: 0 });
    }

    /** Adds runs and reported dollars to today's log: an append, so the background reviewer and a person's run never lose each other's count. */
    addSpend(runs: number, usd: number | undefined, day = localDay()): void {
        fs.mkdirSync(path.join(this.dir, 'spend'), { recursive: true });
        fs.appendFileSync(this.spendFile(day), `${JSON.stringify({ runs, ...(usd ? { usd } : {}), at: new Date().toISOString() })}\n`);
    }

    /** One line per finished review: how it ran, what one judge would have been given and what every run was (the savings ledger reads it). */
    recordCost(entry: ReviewCost): void {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(path.join(this.dir, 'costs.jsonl'), `${JSON.stringify(entry)}\n`);
    }

    /** The last `n` reviews' costs, oldest first; lines that do not parse are skipped. */
    costs(n = COSTS_KEPT): ReviewCost[] {
        let text = '';
        try {
            text = fs.readFileSync(path.join(this.dir, 'costs.jsonl'), 'utf8');
        } catch {
            return [];
        }
        return text.split('\n').flatMap(line => {
            try {
                const entry = JSON.parse(line);
                return entry && typeof entry.actualChars === 'number' && typeof entry.projectedSingleChars === 'number' ? [entry as ReviewCost] : [];
            } catch {
                return [];
            }
        }).slice(-n);
    }

    /** The frozen baseline; written by `freezeBaseline` once, and never again. */
    baseline(): CostBaseline | undefined {
        return this.readJson<CostBaseline>(path.join(this.dir, 'cost-baseline.json'));
    }

    /** Freezes the baseline from the single reviews kept so far, unless it is already frozen; returns the frozen one. */
    freezeBaseline(minSingles: number): CostBaseline {
        const frozen = this.baseline();
        if (frozen) return frozen;
        const singles = this.costs().filter(c => c.mode === 'single' && c.actualUsd > 0 && c.actualChars > 0);
        const chars = singles.reduce((sum, c) => sum + c.actualChars, 0);
        const usd = singles.reduce((sum, c) => sum + c.actualUsd, 0);
        const baseline: CostBaseline = { at: new Date().toISOString(), usdPerChar: singles.length >= minSingles ? usd / chars : null, singles: singles.length };
        this.writeJson(path.join(this.dir, 'cost-baseline.json'), baseline);
        return baseline;
    }

    private spendFile(day: string): string {
        return path.join(this.dir, 'spend', `${day}.jsonl`);
    }

    /** The record of the review (record.ts), beside its verdict. */
    recordPath(verdictPath: string): string {
        return verdictPath.replace(/\.json$/, '.record.json');
    }

    /** The decision a verdict led to (what blocks, what is disputed or a note), kept so the same commit is not decided again. */
    decidedPath(verdictPath: string): string {
        return verdictPath.replace(/\.json$/, '.decided.json');
    }

    /** A review on the branch that ended without a verdict, and why: what the status shows instead of "no verdict yet". */
    recordAttempt(branch: string, attempt: ReviewAttempt): void {
        this.writeJson(this.branchFile(branch, 'attempt'), attempt);
    }

    attempt(branch: string): ReviewAttempt | undefined {
        return this.readJson<ReviewAttempt>(this.branchFile(branch, 'attempt'));
    }

    /** The branch's record (`json`), its last attempt without a verdict (`attempt`), the background reviewer's `pid` and `log`. */
    branchFile(branch: string, kind: 'json' | 'attempt' | 'pid' | 'log' = 'json'): string {
        return path.join(this.dir, 'branches', `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.${kind}`);
    }

    /** Where the background reviewer checks a commit out: under the git directory, never the working tree. */
    worktreeDir(head: string): string {
        return path.join(this.dir, 'worktrees', head.slice(0, 12));
    }
}
