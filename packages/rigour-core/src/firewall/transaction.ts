/**
 * Transactional execution — worktree START → verify → COMMIT | DISCARD.
 */

import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { execa } from 'execa';
import type { PolicyEvaluation, TransactionBudgets, TransactionRecord, TransactionStatus } from './types.js';
import { hashPolicy } from './policy-hash.js';
import { assertWritesInScope } from './scope-enforcement.js';

const DEFAULT_BUDGETS: TransactionBudgets = {
    maxFiles: 20,
    maxRetries: 3,
    maxDurationMs: 30 * 60 * 1000,
};

export class TransactionRunner {
    private record: TransactionRecord;

    constructor(
        private readonly cwd: string,
        opts: {
            agentId?: string;
            scope: string[];
            budgets?: Partial<TransactionBudgets>;
            policyHash?: string;
        },
    ) {
        const budgets = { ...DEFAULT_BUDGETS, ...opts.budgets };
        this.record = {
            id: randomUUID(),
            agentId: opts.agentId,
            scope: opts.scope,
            status: 'START',
            budgets,
            filesChanged: [],
            capabilitiesIssued: [],
            decisions: [],
            startedAt: new Date().toISOString(),
            policyHash: opts.policyHash ?? hashPolicy({ scope: opts.scope, budgets }),
        };
    }

    static fromRecord(cwd: string, record: TransactionRecord): TransactionRunner {
        const runner = new TransactionRunner(cwd, {
            agentId: record.agentId,
            scope: record.scope,
            budgets: record.budgets,
            policyHash: record.policyHash,
        });
        runner.record = { ...record, decisions: [...record.decisions], filesChanged: [...record.filesChanged] };
        return runner;
    }

    getRecord(): TransactionRecord {
        return { ...this.record, decisions: [...this.record.decisions], filesChanged: [...this.record.filesChanged] };
    }

    private setStatus(status: TransactionStatus): void {
        this.record.status = status;
    }

    addDecision(ev: PolicyEvaluation): void {
        this.record.decisions.push(ev);
    }

    /**
     * Create an ephemeral git worktree for isolated writes.
     */
    async start(): Promise<TransactionRecord> {
        const worktreesRoot = path.join(this.cwd, '.rigour', 'worktrees');
        await fs.ensureDir(worktreesRoot);
        const worktreePath = path.join(worktreesRoot, this.record.id);
        const branch = `rigour-tx-${this.record.id.slice(0, 8)}`;

        try {
            await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.cwd });
            await execa('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
                cwd: this.cwd,
                shell: false,
            });
            this.record.worktreePath = worktreePath;
        } catch {
            // Fallback: copy-less sandbox dir (no git) — still tracks commit/discard via marker
            await fs.ensureDir(worktreePath);
            this.record.worktreePath = worktreePath;
            await fs.writeJson(path.join(worktreePath, '.rigour-tx.json'), {
                id: this.record.id,
                base: this.cwd,
            });
        }

        this.setStatus('RUNNING');
        await this.persist();
        return this.getRecord();
    }

    async noteFileChange(relPath: string): Promise<PolicyEvaluation> {
        const scopeEv = await assertWritesInScope(this.cwd, [relPath], this.record.agentId);
        this.addDecision(scopeEv);
        if (scopeEv.decision !== 'allow') {
            return scopeEv;
        }
        if (!this.record.filesChanged.includes(relPath)) {
            this.record.filesChanged.push(relPath);
        }
        if (this.record.filesChanged.length > this.record.budgets.maxFiles) {
            const deny: PolicyEvaluation = {
                decision: 'deny',
                reason: `File budget exceeded (${this.record.budgets.maxFiles})`,
                ruleId: 'budget.files',
                policyHash: this.record.policyHash,
                timestamp: new Date().toISOString(),
            };
            this.addDecision(deny);
            return deny;
        }
        const elapsed = Date.now() - Date.parse(this.record.startedAt);
        if (elapsed > this.record.budgets.maxDurationMs) {
            const deny: PolicyEvaluation = {
                decision: 'deny',
                reason: 'Time budget exceeded',
                ruleId: 'budget.time',
                policyHash: this.record.policyHash,
                timestamp: new Date().toISOString(),
            };
            this.addDecision(deny);
            return deny;
        }
        await this.persist();
        return scopeEv;
    }

    async syncWorktreeChanges(): Promise<string[]> {
        const root = this.record.worktreePath || this.cwd;
        const files = await listChangedFiles(root);
        for (const f of files) {
            const ev = await this.noteFileChange(f);
            if (ev.decision !== 'allow') {
                throw Object.assign(new Error(ev.reason), { evaluation: ev, code: 'FIREWALL_DENY' });
            }
        }
        return [...this.record.filesChanged];
    }

    getWorktreePath(): string | undefined {
        return this.record.worktreePath;
    }

    async verify(runGates: () => Promise<{ status: string; failedGates: string[]; score?: number }>): Promise<{
        ok: boolean;
        gateResults: { status: string; failedGates: string[]; score?: number };
    }> {
        this.setStatus('VERIFYING');
        const gateResults = await runGates();
        await this.persist();
        return { ok: gateResults.status === 'PASS', gateResults };
    }

    async commit(): Promise<TransactionRecord> {
        this.setStatus('COMMIT');
        this.record.finishedAt = new Date().toISOString();
        // Worktree branch is left for operator merge; attestation binds treeDigest/commitSha
        await this.persist();
        return this.getRecord();
    }

    async discard(): Promise<TransactionRecord> {
        this.setStatus('DISCARD');
        this.record.finishedAt = new Date().toISOString();
        const wt = this.record.worktreePath;
        if (wt && await fs.pathExists(wt)) {
            try {
                await execa('git', ['worktree', 'remove', '--force', wt], { cwd: this.cwd, shell: false });
            } catch {
                await fs.remove(wt);
            }
            try {
                const branch = `rigour-tx-${this.record.id.slice(0, 8)}`;
                await execa('git', ['branch', '-D', branch], { cwd: this.cwd, shell: false, reject: false });
            } catch {
                // ignore
            }
        }
        await this.persist();
        return this.getRecord();
    }

    private async persist(): Promise<void> {
        const dir = path.join(this.cwd, '.rigour', 'transactions');
        await fs.ensureDir(dir);
        await fs.writeJson(path.join(dir, `${this.record.id}.json`), this.record, { spaces: 2 });
        await fs.writeJson(path.join(this.cwd, '.rigour', 'transaction-current.json'), this.record, { spaces: 2 });
    }
}

export async function listChangedFiles(dir: string): Promise<string[]> {
    try {
        const { stdout: diffOut } = await execa('git', ['diff', '--name-only', 'HEAD'], {
            cwd: dir,
            shell: false,
        });
        const { stdout: untrackedOut } = await execa(
            'git',
            ['ls-files', '--others', '--exclude-standard'],
            { cwd: dir, shell: false },
        );
        const files = [
            ...diffOut.split('\n'),
            ...untrackedOut.split('\n'),
        ].map(s => s.trim()).filter(Boolean);
        return [...new Set(files)];
    } catch {
        return [];
    }
}

export async function loadCurrentTransaction(cwd: string): Promise<TransactionRecord | null> {
    const p = path.join(cwd, '.rigour', 'transaction-current.json');
    if (!(await fs.pathExists(p))) return null;
    try {
        return await fs.readJson(p);
    } catch {
        return null;
    }
}

export async function listTransactions(cwd: string): Promise<TransactionRecord[]> {
    const dir = path.join(cwd, '.rigour', 'transactions');
    if (!(await fs.pathExists(dir))) return [];
    const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    const out: TransactionRecord[] = [];
    for (const f of files) {
        try {
            out.push(await fs.readJson(path.join(dir, f)));
        } catch {
            // skip
        }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
