/**
 * The "before you say done" review: when an agent is about to stop, review the
 * whole branch against the commit it left main at (committed, uncommitted and new
 * files alike; on main itself, what the session changed since its baseline) and,
 * if it introduced serious findings, tell the agent what to fix instead of
 * letting it finish. A review with nothing to look at says so; it is never
 * reported as a clean pass.
 *
 * Only findings that deserve it block: critical ones, high ones that are proven
 * (the semantic engine traced them) or security findings, findings the change added that are
 * certain from the code alone (MUST_FIX: dead code, offset paging, an unbounded window, a
 * duplicate function), and on a branch a merge conflict with main or a mention of a file the
 * branch deleted (review/branch-checks.ts).
 * A high heuristic (a regex that sees `fetch` without `.catch`) is not enough to
 * hold an agent back; callers also cap the number of attempts.
 */
import type { Config, Failure, Severity } from '../types/index.js';
import { reviewChange } from '../review/review.js';
import { buildReviewTask, type ReviewTaskItem } from '../review/review-task.js';
import { diffFromGit, type DiffSource } from '../review/git-diff.js';
import { branchBase } from '../gates/logic-drift-git-base.js';
import { branchFailures } from '../review/branch-checks.js';

export const STOP_MAX_ATTEMPTS = 3;
const MAX_LISTED = 8;

export interface StopDecision {
    block: boolean;
    /** What the agent is told when blocked; empty otherwise. */
    message: string;
    blocking: number;
    /** Every finding on changed lines, and the files the review covered (for fix capture). */
    findings: Failure[];
    reviewedFiles: string[];
    /** What the review was measured against, e.g. `origin/main @ 1a2b3c4` or `uncommitted work`. */
    against: string;
}

/** The branch since it left main; on main, what the session changed since its baseline (session-state.ts). */
function stopSource(cwd: string, sessionBaseline?: string): { source: DiffSource; against: string } {
    const branch = branchBase(cwd);
    if (branch && !branch.onMain) {
        return { source: { mode: 'since', commit: branch.base }, against: `${branch.mainRef.replace(/^refs\/(remotes\/|heads\/)/, '')} @ ${branch.base.slice(0, 7)}` };
    }
    return sessionBaseline
        ? { source: { mode: 'since', commit: sessionBaseline }, against: `this session's start @ ${sessionBaseline.slice(0, 7)}` }
        : { source: { mode: 'working' }, against: 'uncommitted work' };
}

/** `sessionBaseline`: the commit the session started from, used on main (session-state.ts). */
export async function stopReview(cwd: string, config: Config, attempt: number, sessionBaseline?: string): Promise<StopDecision> {
    const { source, against } = stopSource(cwd, sessionBaseline);
    const diff = diffFromGit(cwd, source);
    const result = await reviewChange({ cwd, config, diff, source });
    const branch = branchBase(cwd);
    const whole = branch && !branch.onMain ? branchFailures(cwd, branch.base, branch.mainRef, config) : [];
    const blocking = [...result.findings.filter(blocksStop), ...whole];
    const unreviewed = config.hooks?.require_review_ack ? buildReviewTask(cwd, diff, config.gates.deep?.router).items : [];
    const reviewed = { findings: result.findings, reviewedFiles: Object.keys(result.changedLines), against };
    if (blocking.length === 0 && unreviewed.length === 0) return { block: false, message: '', blocking: 0, ...reviewed };
    const message = [
        ...(blocking.length ? [stopMessage(blocking, attempt)] : []),
        ...(unreviewed.length ? [reviewAckMessage(unreviewed, attempt)] : []),
    ].join('\n\n');
    return { block: true, message, blocking: blocking.length + unreviewed.length, ...reviewed };
}

export function reviewAckMessage(items: ReviewTaskItem[], attempt: number): string {
    const listed = items.slice(0, MAX_LISTED).map(i => `- ${i.file}:${i.start} \`${i.function}\`: ${i.questions[0]}`);
    return [
        `${items.length} risky changed function(s) have not been reviewed (attempt ${attempt} of ${STOP_MAX_ATTEMPTS}).`,
        'Call rigour_review with mode "agent" for the questions, check each function, then rigour_review_ack it:',
        ...listed,
    ].join('\n');
}

/** Certain from the code alone, and quick to fix (each measured with no false alarms before it blocks). */
const MUST_FIX = new Set(['unused-export', 'orphan-file', 'offset-paging', 'unbounded-window', 'duplicate-function', 'partial-fix', 'partial-wiring']);

/** Critical; high and either proven by the semantic engine or a security finding; or a certain, local finding the change added (MUST_FIX). */
export function blocksStop(finding: Failure): boolean {
    const severity = (finding.severity || 'medium') as Severity;
    if (severity === 'critical' || MUST_FIX.has(finding.id)) return true;
    return severity === 'high' && (finding.verified === true || finding.provenance === 'security');
}

export function stopMessage(findings: Failure[], attempt: number): string {
    const listed = findings.slice(0, MAX_LISTED).map(f => {
        const where = `${f.files?.[0] ?? '?'}:${f.line ?? '?'}`;
        return `- [${(f.severity || 'medium').toUpperCase()}] ${where} ${f.title}${f.hint ? `\n  Fix: ${f.hint}` : ''}`;
    });
    const more = findings.length > MAX_LISTED ? [`- …and ${findings.length - MAX_LISTED} more (run \`rigour review\`).`] : [];
    return [
        `Rigour review found ${findings.length} issue(s) to fix in what this branch changed (attempt ${attempt} of ${STOP_MAX_ATTEMPTS}).`,
        'Fix them before finishing, or explain why a finding is wrong:',
        ...listed,
        ...more,
    ].join('\n');
}
