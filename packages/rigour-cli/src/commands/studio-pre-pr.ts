/**
 * The pre-PR review as Studio shows it: what was reviewed and fixed before a
 * PR existed, what is still waiting, and what model review actually cost
 * (observed per run, never estimated). Keys are never read here.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import {
    buildReviewTask, ConfigSchema, diffFromGit, readDeepRuns, readLedger, summarizeDeepRuns,
    type DeepRunSummary, type LedgerEntry, type ReviewTaskItem,
} from '@rigour-labs/core';

const RECENT = 20;

export interface StudioPrePrReview {
    reviewed: { total: number; fixed: number; noIssue: number; byReviewer: Record<string, number> };
    recent: Array<Pick<LedgerEntry, 'file' | 'function' | 'verdict' | 'reviewer' | 'note' | 'at'>>;
    pending: ReviewTaskItem[];
    spend: DeepRunSummary;
    lastModel?: string;
}

export function loadPrePrReview(cwd: string): StudioPrePrReview {
    const ledger = readLedger(cwd);
    const runs = readDeepRuns(cwd);
    const byReviewer: Record<string, number> = {};
    for (const entry of ledger) {
        const who = entry.reviewer.startsWith('byok:') ? 'byok' : entry.reviewer;
        byReviewer[who] = (byReviewer[who] ?? 0) + 1;
    }
    return {
        reviewed: {
            total: ledger.length,
            fixed: ledger.filter(e => e.verdict === 'fixed').length,
            noIssue: ledger.filter(e => e.verdict === 'no_issue').length,
            byReviewer,
        },
        recent: ledger.slice(-RECENT).reverse().map(({ file, function: fn, verdict, reviewer, note, at }) => ({ file, function: fn, verdict, reviewer, note, at })),
        pending: pendingItems(cwd),
        spend: summarizeDeepRuns(runs),
        lastModel: [...runs].reverse().find(r => r.model)?.model,
    };
}

/** Risky functions in uncommitted work not yet reviewed; none outside a git repository. */
function pendingItems(cwd: string): ReviewTaskItem[] {
    try {
        return buildReviewTask(cwd, diffFromGit(cwd, { mode: 'working' }), routerPolicy(cwd)).items;
    } catch {
        return [];
    }
}

function routerPolicy(cwd: string) {
    try {
        const file = path.join(cwd, 'rigour.yml');
        const raw = fs.existsSync(file) ? yaml.parse(fs.readFileSync(file, 'utf8')) : {};
        return ConfigSchema.parse(raw).gates.deep?.router;
    } catch {
        return undefined;
    }
}
