/**
 * The "before you say done" review: when an agent is about to stop, review the
 * whole branch against the commit it left main at (committed, uncommitted and new
 * files alike; on main itself, what the session changed since its baseline) and,
 * if it introduced serious findings, tell the agent what to fix instead of
 * letting it finish. A review with nothing to look at says so; it is never
 * reported as a clean pass.
 *
 * What blocks is what the review itself reports (review/quiet.ts `mustFix`: proven, critical, or
 * high and verified or from a security gate), plus on a branch a merge conflict with main or a
 * mention of a file the branch deleted (review/branch-checks.ts). The same rule decides the push
 * gate, so a stop, a review and a push never disagree about a finding. A high heuristic (a regex
 * that sees `fetch` without `.catch`) is not enough to hold an agent back; callers also cap the
 * number of attempts.
 */
import { createHash } from 'crypto';
import type { Config, Failure } from '../types/index.js';
import { reviewChange } from '../review/review.js';
import { buildReviewTask, type ReviewTaskItem } from '../review/review-task.js';
import { diffFromGit, type DiffSource } from '../review/git-diff.js';
import { branchBase } from '../gates/logic-drift-git-base.js';
import { branchFailures } from '../review/branch-checks.js';
import { describeLesson, type LessonView } from '../review-learning/team-lessons.js';
import { hookGoalDescription, recordGoal } from '../goal/hook.js';

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
    /** What this team learned that applies to the change (verified lessons; rules when `gates.deep.repo_rules` is on), keyed for asking once. */
    guidance: TeamGuidance[];
}

export interface TeamGuidance { key: string; text: string }

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
    const goalDescription = await hookGoalDescription(cwd, config);
    const result = await reviewChange({ cwd, config, diff, source, ...(goalDescription !== undefined ? { goalDescription } : {}) });
    recordGoal(cwd, 'stop', goalDescription, result);
    const branch = branchBase(cwd);
    const whole = branch && !branch.onMain ? branchFailures(cwd, branch.base, branch.mainRef, config) : [];
    // A check that could not run is never a pass; the attempt cap keeps a broken environment from looping forever.
    const crashed: Failure[] = result.status === 'ERROR'
        ? result.gateErrors.map(id => ({ id, title: 'A check could not run', details: id === 'typed-checks-unavailable' && result.typedError ? result.typedError : `${id} crashed instead of running`, severity: 'high', files: [], hint: 'Fix the environment (dependencies, generated config), then try again.' }))
        : [];
    const blocking = [...result.findings, ...whole, ...crashed];
    const task = buildReviewTask(cwd, diff, config.gates.deep?.router, config.gates.deep?.review_lessons, config.gates.deep?.repo_rules ?? false);
    const unreviewed = config.hooks?.require_review_ack ? task.items : [];
    const reviewed = { findings: result.findings, reviewedFiles: Object.keys(result.changedLines), against, guidance: teamGuidance(task) };
    if (blocking.length === 0 && unreviewed.length === 0) return { block: false, message: '', blocking: 0, ...reviewed };
    const message = [
        ...(blocking.length ? [stopMessage(blocking, attempt)] : []),
        ...(unreviewed.length ? [reviewAckMessage(unreviewed, attempt)] : []),
    ].join('\n\n');
    return { block: true, message, blocking: blocking.length + unreviewed.length, ...reviewed };
}

/** Each lesson and rule once, keyed by its text so the same one is never asked twice in a session. */
function teamGuidance(task: { lessons: LessonView[]; rules: Array<{ source: string; text: string }> }): TeamGuidance[] {
    const key = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
    return [
        ...task.lessons.map(l => ({ key: key(`lesson\u0000${l.file}\u0000${l.text}`), text: describeLesson(l) })),
        ...task.rules.map(r => ({ key: key(`rule\u0000${r.source}\u0000${r.text}`), text: `${r.source}: ${r.text}` })),
    ];
}

/** Asked once per new lesson or rule: the senior's question at the end of the task, never a loop. */
export function teamMessage(guidance: TeamGuidance[]): string {
    return [
        'Before you finish, check this change against what this team learned on earlier work that applies to it.',
        'If the change repeats one, fix it; if none applies, say so in one line and finish:',
        ...guidance.slice(0, MAX_LISTED).map(g => `- ${g.text}`),
    ].join('\n');
}

export function reviewAckMessage(items: ReviewTaskItem[], attempt: number): string {
    const listed = items.slice(0, MAX_LISTED).map(i => `- ${i.file}:${i.start} \`${i.function}\`: ${i.questions[0]}`);
    return [
        `${items.length} risky changed function(s) have not been reviewed (attempt ${attempt} of ${STOP_MAX_ATTEMPTS}).`,
        'Call rigour_review with mode "agent" for the questions, check each function, then rigour_review_ack it:',
        ...listed,
    ].join('\n');
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
