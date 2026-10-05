/**
 * rigour_review: the same review as `rigour review` (core reviewChange), so an
 * agent and CI get the same verdict for the same change.
 *
 * With no diff, the change is taken from git: uncommitted work (what the
 * agent just wrote, new files included), or the branch against `base`.
 */
import { acknowledgeReview, buildQualityReceipt, buildReviewTask, receiptReport, diffFromGit, recordFixLessons, recordLessonsServed, recordReviewOutcome, reviewChange, toReviewFinding, type Config } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export interface ReviewArgs {
    diff?: string;
    base?: string;
    files?: string[];
    /** "agent": also return the risky changed functions for the calling agent to review itself. */
    mode?: 'gates' | 'agent';
}

export interface ReviewAckArgs {
    file: string;
    function: string;
    verdict: string;
    note: string;
}

/** What is known about each changed function before a model looks; never fails the review. */
function qualityReceipt(config: Config, cwd: string, diff: string) {
    try {
        return { quality_receipt: receiptReport(buildQualityReceipt(cwd, diff, { policy: config.gates.deep?.router, lessonMode: config.gates.deep?.review_lessons })) };
    } catch {
        return {};
    }
}

export async function handleReview(config: Config, cwd: string, args: ReviewArgs): Promise<ToolResult> {
    notifyProgress("info", args.diff ? "Reviewing the provided diff..." : `Reviewing ${args.base ? `this branch against ${args.base}` : "uncommitted changes"}...`);
    try {
        const diff = args.diff ?? diffFromGit(cwd, args.base ? { mode: 'base', base: args.base } : { mode: 'working' });
        const result = await reviewChange({ cwd, config, diff, files: args.files });
        const task = args.mode === 'agent' ? buildReviewTask(cwd, diff, config.gates.deep?.router, config.gates.deep?.review_lessons, config.gates.deep?.repo_rules) : undefined;
        const capture = recordReviewOutcome(cwd, result.findings, Object.keys(result.changedLines), 'review');
        if (task) recordLessonsServed(cwd, 'review', task.lessons.map(l => l.text));
        await recordFixLessons(cwd, capture.fixes).catch(() => undefined); // learning never fails a review
        const stats = result.report?.stats;
        return text({
            status: result.status,
            score: stats?.score ?? 100,
            ai_health_score: stats?.ai_health_score,
            structural_score: stats?.structural_score,
            changed_files: Object.keys(result.changedLines).length,
            failures: result.findings.map(toReviewFinding),
            file_findings: result.fileFindings.map(toReviewFinding),
            context_findings: result.contextFindings.map(toReviewFinding),
            advisory_count: result.advisory.length,
            muted_count: result.muted,
            excluded_outside_changed_lines: result.excludedOutsideChangedLines,
            preexisting_not_reported: result.preexisting,
            unlocated_failures: result.unlocated,
            gate_errors: result.gateErrors,
            ...qualityReceipt(config, cwd, diff),
            ...(task ? { review_task: { items: task.items, already_reviewed: task.alreadyReviewed, team_lessons: task.lessons, repo_rules: task.rules, instructions: task.instructions } } : {}),
            next_step: nextStep(result.findings.length, task?.items.length ?? 0),
        });
    } catch (error) {
        return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
}

/** rigour_review_ack: record that a review-task function was checked (verdict and what was checked). */
export function handleReviewAck(cwd: string, args: ReviewAckArgs): ToolResult {
    const result = acknowledgeReview(cwd, { ...args, reviewer: 'agent' });
    if (!result.ok) return { ...text({ error: result.error }), isError: true };
    return text({ recorded: { file: result.entry.file, function: result.entry.function, verdict: result.entry.verdict } });
}

function nextStep(findings: number, unreviewed: number): string {
    if (findings) return "Fix each failure at its file:line (see suggestion), then call rigour_review again.";
    if (unreviewed) return "Review each review_task item (read its callers and callees, answer its questions), fix real defects, then call rigour_review_ack for it.";
    return "No findings on changed lines.";
}

function text(value: unknown): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
