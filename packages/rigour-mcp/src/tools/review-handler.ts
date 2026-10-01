/**
 * rigour_review: the same review as `rigour review` (core reviewChange), so an
 * agent and CI get the same verdict for the same change.
 *
 * With no diff, the change is taken from git: uncommitted work (what the
 * agent just wrote, new files included), or the branch against `base`.
 */
import { recordReviewOutcome, reviewChange, toReviewFinding, type Config } from "@rigour-labs/core";
import { notifyProgress } from '../utils/notifications.js';

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export interface ReviewArgs {
    diff?: string;
    base?: string;
    files?: string[];
}

export async function handleReview(config: Config, cwd: string, args: ReviewArgs): Promise<ToolResult> {
    notifyProgress("info", args.diff ? "Reviewing the provided diff..." : `Reviewing ${args.base ? `this branch against ${args.base}` : "uncommitted changes"}...`);
    try {
        const result = await reviewChange({
            cwd, config, diff: args.diff,
            source: args.base ? { mode: 'base', base: args.base } : { mode: 'working' },
            files: args.files,
        });
        recordReviewOutcome(cwd, result.findings, Object.keys(result.changedLines));
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
            excluded_outside_changed_lines: result.excludedOutsideChangedLines,
            unlocated_failures: result.unlocated,
            next_step: result.findings.length
                ? "Fix each failure at its file:line (see suggestion), then call rigour_review again."
                : "No findings on changed lines.",
        });
    } catch (error) {
        return { ...text({ error: error instanceof Error ? error.message : String(error) }), isError: true };
    }
}

function text(value: unknown): ToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
