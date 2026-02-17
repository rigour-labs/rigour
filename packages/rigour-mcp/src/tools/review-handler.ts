/**
 * Code Review Tool Handler
 *
 * Handler for: rigour_review
 *
 * @since v2.17.0 — extracted from monolithic index.ts
 */
import { GateRunner } from "@rigour-labs/core";
import { parseDiff } from '../utils/config.js';

type ToolResult = { content: { type: string; text: string }[] };

export async function handleReview(
    runner: GateRunner,
    cwd: string,
    diff: string,
    changedFiles?: string[]
): Promise<ToolResult> {
    // 1. Map diff to line numbers for filtering
    const diffMapping = parseDiff(diff);
    const targetFiles = changedFiles || Object.keys(diffMapping);

    // 2. Run high-fidelity analysis on changed files
    const report = await runner.run(cwd, targetFiles);

    // 3. Filter failures to only those on changed lines (or global gate failures)
    const filteredFailures = report.failures.filter(failure => {
        if (!failure.files || failure.files.length === 0) return true;

        return failure.files.some(file => {
            const fileModifiedLines = diffMapping[file];
            if (!fileModifiedLines) return false;
            if (failure.line !== undefined) return fileModifiedLines.has(failure.line);
            return true;
        });
    });

    return {
        content: [{
            type: "text",
            text: JSON.stringify({
                status: filteredFailures.length > 0 ? "FAIL" : "PASS",
                score: report.stats.score,
                ai_health_score: report.stats.ai_health_score,
                structural_score: report.stats.structural_score,
                failures: filteredFailures.map(f => ({
                    id: f.id,
                    gate: f.title,
                    severity: f.severity || 'medium',
                    provenance: f.provenance || 'traditional',
                    message: f.details,
                    file: f.files?.[0] || "",
                    line: f.line || 1,
                    suggestion: f.hint,
                })),
            }),
        }],
    };
}
