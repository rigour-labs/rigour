/**
 * The goal check's record for `rigour review --json`: whether it ran, which layer decided, what the description
 * declared, and why a check that was on checked nothing (docs/GOAL.md).
 */
import type { ResolvedSwitch, ReviewResult } from '@rigour-labs/core';

/** What the goal check did on this run, and why: for the JSON record and a line in the human verdict. */
export interface GoalReport {
    enabled: boolean;
    source: ResolvedSwitch['source'];
    required: boolean;
    refused: string[];
    /** Whether the description declared anything to check (Scope, Out of scope, or a Done when item naming a file or symbol). */
    declared: boolean;
    scope?: string[];
    out_of_scope?: string[];
    done_when?: number;
    /** Why a check that is on checked nothing. */
    reason?: string;
}

export function goalReport(goal: ResolvedSwitch, description: string | undefined, result: Pick<ReviewResult, 'goal'>): GoalReport {
    return {
        enabled: goal.enabled, source: goal.source, required: goal.required, refused: goal.refused, declared: !!result.goal,
        ...(result.goal ? { scope: result.goal.scope, out_of_scope: result.goal.outOfScope, done_when: result.goal.doneWhen.length } : {}),
        ...(goal.enabled && description === undefined ? { reason: 'no pull request description: pass --pr-body, or run in a pull request\'s GitHub Actions job' } : {}),
        ...(goal.enabled && description !== undefined && !result.goal ? { reason: 'the description declares no Scope, Out of scope, or Done when item naming a file or symbol' } : {}),
    };
}
