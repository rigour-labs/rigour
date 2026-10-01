/**
 * Deep runs, as they happened: model, tokens, cost, what the router sent and
 * skipped. Every deep review appends one line (.rigour/deep-runs.jsonl), so
 * Studio reports observed spend, never an estimate of what a run might cost.
 */
import fs from 'fs';
import path from 'path';
import type { Report } from '../types/index.js';

const LOG = path.join('.rigour', 'deep-runs.jsonl');
const MAX_LOG_BYTES = 1024 * 1024;

export type DeepRunStats = NonNullable<Report['stats']['deep']>;

export interface DeepRun extends DeepRunStats {
    at: string;
}

export interface DeepRunSummary {
    runs: number;
    /** Sum over runs that reported a cost; runs without one are counted in `unpricedRuns`. */
    costUsd: number;
    unpricedRuns: number;
    inputTokens: number;
    outputTokens: number;
    functionsRanked: number;
    functionsRouted: number;
    /** Risky functions the model was not asked about because they were reviewed before. */
    alreadyReviewed: number;
    toolCalls: number;
    findingsKept: number;
}

export function appendDeepRun(cwd: string, stats: DeepRunStats, at = new Date().toISOString()): void {
    if (!stats.enabled || stats.status === 'error') return;
    try {
        const file = path.join(cwd, LOG);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify({ at, ...stats }) + '\n');
        if (fs.statSync(file).size > MAX_LOG_BYTES) {
            const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
            fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
        }
    } catch {
        // Recording spend must never fail a review.
    }
}

export function readDeepRuns(cwd: string): DeepRun[] {
    try {
        return fs.readFileSync(path.join(cwd, LOG), 'utf8').split('\n').filter(Boolean)
            .flatMap(line => { try { return [JSON.parse(line) as DeepRun]; } catch { return []; } });
    } catch {
        return [];
    }
}

export function summarizeDeepRuns(runs: DeepRun[]): DeepRunSummary {
    const summary: DeepRunSummary = {
        runs: runs.length, costUsd: 0, unpricedRuns: 0, inputTokens: 0, outputTokens: 0,
        functionsRanked: 0, functionsRouted: 0, alreadyReviewed: 0, toolCalls: 0, findingsKept: 0,
    };
    for (const run of runs) {
        if (typeof run.cost_usd === 'number') summary.costUsd += run.cost_usd;
        else if (run.tier === 'cloud') summary.unpricedRuns++;
        summary.inputTokens += run.input_tokens ?? 0;
        summary.outputTokens += run.output_tokens ?? 0;
        summary.functionsRanked += run.router?.functions ?? 0;
        summary.functionsRouted += run.router?.routed ?? 0;
        summary.alreadyReviewed += run.router?.already_reviewed ?? 0;
        summary.toolCalls += run.tool_calls ?? 0;
        summary.findingsKept += run.findings_count ?? 0;
    }
    return summary;
}
