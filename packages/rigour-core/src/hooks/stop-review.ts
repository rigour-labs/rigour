/**
 * The "before you say done" review: when an agent is about to stop, review what
 * the session changed (since its baseline commit, or the uncommitted change when
 * none was recorded) and, if it introduced serious findings, tell the agent what
 * to fix instead of letting it finish.
 *
 * Only findings that deserve it block: critical ones, and high ones that are
 * proven (the semantic engine traced them) or security findings. A high
 * heuristic (a regex that sees `fetch` without `.catch`) is not enough to hold
 * an agent back; callers also cap the number of attempts.
 */
import type { Config, Failure, Severity } from '../types/index.js';
import { reviewChange } from '../review/review.js';
import { buildReviewTask, type ReviewTaskItem } from '../review/review-task.js';
import { diffFromGit, type DiffSource } from '../review/git-diff.js';

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
}

/** `since`: the session's baseline commit (session-state.ts); committing after it hides nothing. */
export async function stopReview(cwd: string, config: Config, attempt: number, since?: string): Promise<StopDecision> {
    const source: DiffSource = since ? { mode: 'since', commit: since } : { mode: 'working' };
    const diff = diffFromGit(cwd, source);
    const result = await reviewChange({ cwd, config, diff, source });
    const blocking = result.findings.filter(blocksStop);
    const unreviewed = config.hooks?.require_review_ack ? buildReviewTask(cwd, diff, config.gates.deep?.router).items : [];
    const reviewed = { findings: result.findings, reviewedFiles: Object.keys(result.changedLines) };
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

/** Critical, or high and either proven by the semantic engine or a security finding. */
export function blocksStop(finding: Failure): boolean {
    const severity = (finding.severity || 'medium') as Severity;
    if (severity === 'critical') return true;
    return severity === 'high' && (finding.verified === true || finding.provenance === 'security');
}

export function stopMessage(findings: Failure[], attempt: number): string {
    const listed = findings.slice(0, MAX_LISTED).map(f => {
        const where = `${f.files?.[0] ?? '?'}:${f.line ?? '?'}`;
        return `- [${(f.severity || 'medium').toUpperCase()}] ${where} ${f.title}${f.hint ? `\n  Fix: ${f.hint}` : ''}`;
    });
    const more = findings.length > MAX_LISTED ? [`- …and ${findings.length - MAX_LISTED} more (run \`rigour review\`).`] : [];
    return [
        `Rigour review found ${findings.length} serious issue(s) on the lines you changed (attempt ${attempt} of ${STOP_MAX_ATTEMPTS}).`,
        'Fix them before finishing, or explain why a finding is wrong:',
        ...listed,
        ...more,
    ].join('\n');
}
