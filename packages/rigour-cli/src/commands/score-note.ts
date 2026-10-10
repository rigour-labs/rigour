/**
 * What a score below 100 means, in one line: a person seeing "PASS (62/100)" should not have to guess why a note that
 * never blocks cost points. The weights are read from the ones the score is computed with (SEVERITY_WEIGHTS).
 */
import { SEVERITY_WEIGHTS } from '@rigour-labs/core';

/** Undefined at 100 or with no score; `review` adds that only the findings to fix decide its verdict. */
export function scoreNote(score: number | undefined, review = false): string | undefined {
    if (score === undefined || score >= 100) return undefined;
    const weights = (['critical', 'high', 'medium', 'low'] as const).map(s => `${s} ${SEVERITY_WEIGHTS[s]}`).join(', ');
    return `Score ${score}/100 counts every finding in the files checked, notes included (${weights} points each, capped per check)${review ? '; only the findings to fix decide the verdict' : ''}.`;
}
