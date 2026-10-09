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

/** A finished review's cost, for the orchestrator's guard: `single` (one judge) or `orchestrator`. */
export interface ReviewCost { at: string; mode: 'single' | 'orchestrator'; lines: number; usd: number; runs: number }
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

    /** One line per finished review: how it ran, the lines it covered and what its runs reported costing (the orchestrator's cost guard reads it). */
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
                return entry && typeof entry.usd === 'number' && typeof entry.lines === 'number' ? [entry as ReviewCost] : [];
            } catch {
                return [];
            }
        }).slice(-n);
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
