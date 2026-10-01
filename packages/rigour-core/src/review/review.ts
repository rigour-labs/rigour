/**
 * reviewChange: the one review engine behind `rigour review`, the MCP
 * `rigour_review` tool and the GitHub integration.
 *
 * Runs the configured gates on the files a change touches and keeps what
 * belongs to the change (see changed-lines.ts). A deep run that was asked for
 * but could not analyze anything makes the result ERROR, never a clean PASS.
 */
import { GateRunner } from '../gates/runner.js';
import type { Config, DeepOptions, Failure, Report } from '../types/index.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { normalizeScopePatterns } from '../utils/scope.js';
import { deepAnalysisError } from '../utils/deep-status.js';
import { splitByChangedLines } from './changed-lines.js';
import { changedFunctionSpans } from './changed-function-spans.js';
import { diffFromGit, type DiffSource } from './git-diff.js';
import { diffTestFailures } from './diff-test-findings.js';

export interface ReviewInput {
    cwd: string;
    config: Config;
    /** A unified diff; when omitted, it is taken from git (`source`). */
    diff?: string;
    source?: DiffSource;
    /** Review exactly these files instead of the ones the diff touches. */
    files?: string[];
    /** Run changed functions before and after the change (needs deep, on the max or a cloud tier). */
    diffTests?: boolean;
    /** Deep analysis; `focusLines` and `removedLines` are filled from the diff. */
    deep?: Omit<DeepOptions, 'focusLines' | 'removedLines'>;
}

export interface ReviewResult {
    status: 'PASS' | 'FAIL' | 'ERROR';
    findings: Failure[];
    fileFindings: Failure[];
    /** Deep findings elsewhere in a changed file: shown, never blocking. */
    contextFindings: Failure[];
    unlocated: number;
    excludedOutsideChangedLines: number;
    changedLines: Record<string, Set<number>>;
    report: Report | null;
    deepError?: string;
}

export interface ReviewFinding {
    id: string;
    gate: string;
    severity: string;
    provenance: string;
    message: string;
    file: string;
    line: number | null;
    /** For a finding inside a changed function but off the changed lines: the changed line to post it on. */
    anchor_line?: number;
    suggestion?: string;
}

export async function reviewChange(input: ReviewInput): Promise<ReviewResult> {
    const diff = input.diff ?? diffFromGit(input.cwd, input.source);
    const changedLines = parseDiff(diff);
    const targets = input.files?.length ? input.files : Object.keys(changedLines);
    if (targets.length === 0) {
        return { status: 'PASS', findings: [], fileFindings: [], contextFindings: [], unlocated: 0, excludedOutsideChangedLines: 0, changedLines, report: null };
    }
    const deep = input.deep ? { ...input.deep, focusLines: changedLinesByFile(changedLines), removedLines: removedByFile(diff) } : undefined;
    const report = await new GateRunner(input.config).run(input.cwd, await normalizeScopePatterns(input.cwd, targets), deep);
    if (input.diffTests && deep) report.failures.push(...await diffTestFailures(input.cwd, input.source, deep));
    const split = splitByChangedLines(report.failures, changedLines, deep ? changedFunctionSpans(input.cwd, changedLines) : {});
    const deepError = deepAnalysisError(report);
    return {
        status: deepError ? 'ERROR' : split.findings.length > 0 ? 'FAIL' : 'PASS',
        findings: split.findings,
        fileFindings: split.fileFindings,
        contextFindings: split.contextFindings,
        unlocated: split.unlocated,
        excludedOutsideChangedLines: split.outside,
        changedLines,
        report,
        ...(deepError ? { deepError } : {}),
    };
}

/** The JSON shape of a finding, shared by the CLI's --json and the MCP tool. */
export function toReviewFinding(failure: Failure): ReviewFinding {
    return {
        id: failure.id,
        gate: failure.title,
        severity: failure.severity || 'medium',
        provenance: failure.provenance || 'traditional',
        message: failure.details,
        file: failure.files?.[0] || '',
        line: failure.line ?? null,
        ...(failure.anchorLine !== undefined ? { anchor_line: failure.anchorLine } : {}),
        ...(failure.hint ? { suggestion: failure.hint } : {}),
    };
}
