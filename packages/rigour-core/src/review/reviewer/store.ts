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

export interface BranchState {
    head: string;
    verdict: string;
    mode: 'full' | 'delta';
    chain: number;
    rulesHash: string;
    reviewsKey: string;
    at: string;
}

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

    /** The branch's record (`json`), the background reviewer's `pid` and `log`. */
    branchFile(branch: string, kind: 'json' | 'pid' | 'log' = 'json'): string {
        return path.join(this.dir, 'branches', `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}.${kind}`);
    }

    /** Where the background reviewer checks a commit out: under the git directory, never the working tree. */
    worktreeDir(head: string): string {
        return path.join(this.dir, 'worktrees', head.slice(0, 12));
    }
}
