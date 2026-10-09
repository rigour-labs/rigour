/**
 * What the reviewer did, as anonymous opt-in telemetry (TELEMETRY.md): counts and buckets only, never code, file
 * names, finding text or ids. It answers whether anyone turns the panel on, what actually runs, and what it costs.
 */
import { costBucket } from '../../telemetry/telemetry.js';
import type { ReviewerResult } from '../reviewer.js';

export function reviewerUsage(result: ReviewerResult, trigger: string): Record<string, unknown> {
    const mode = result.mode;
    return {
        outcome: result.outcome,
        trigger,
        scope: result.scope,
        asked: mode?.asked,
        ran: mode?.ran,
        source: mode?.source,
        degraded: !!mode?.degraded,
        escalation: mode?.escalation ? (mode.ran === 'single' ? 'one-judge' : 'all-judges') : undefined,
        refused: mode?.refused?.length ?? 0,
        judges: result.reviewers.length,
        cached: result.cached,
        confirmed: result.items.length,
        disputed: result.disputed.length,
        dropped: result.dropped.length,
        notes: result.notes.length,
        dismissed: result.dismissed.length,
        runs: result.runs,
        cost_bucket: costBucket(result.costUsd),
        ...orchestrated(mode?.specialists),
    };
}

/** With the orchestrator: how many parts triage picked, how many passes ran, whether it split, fell back or had nothing to review, and how many passes read beyond their slice. */
function orchestrated(specialists: NonNullable<ReviewerResult['mode']>['specialists']): Record<string, unknown> {
    if (!specialists) return {};
    return {
        parts: specialists.selected.length,
        passes: specialists.passes.length,
        split: specialists.passes.length > 1,
        fallback: !!specialists.fallback,
        nothing_to_review: !!specialists.none,
        beyond_slice: specialists.passes.filter(p => p.readBeyondSlice === true).length,
    };
}
