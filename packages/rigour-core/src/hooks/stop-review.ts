/**
 * The "before you say done" review: when an agent is about to stop, review the
 * uncommitted change and, if it introduced serious findings, tell the agent
 * what to fix instead of letting it finish.
 *
 * Only findings that deserve it block: critical ones, and high ones that are
 * proven (the semantic engine traced them) or security findings. A high
 * heuristic (a regex that sees `fetch` without `.catch`) is not enough to hold
 * an agent back; callers also cap the number of attempts.
 */
import type { Config, Failure, Severity } from '../types/index.js';
import { reviewChange } from '../review/review.js';

export const STOP_MAX_ATTEMPTS = 3;
const MAX_LISTED = 8;

export interface StopDecision {
    block: boolean;
    /** What the agent is told when blocked; empty otherwise. */
    message: string;
    blocking: number;
}

export async function stopReview(cwd: string, config: Config, attempt: number): Promise<StopDecision> {
    const result = await reviewChange({ cwd, config, source: { mode: 'working' } });
    const blocking = result.findings.filter(blocksStop);
    if (blocking.length === 0) return { block: false, message: '', blocking: 0 };
    return { block: true, message: stopMessage(blocking, attempt), blocking: blocking.length };
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
