/**
 * reviewChange: the one review engine behind `rigour review`, the MCP
 * `rigour_review` tool and the GitHub integration.
 *
 * Runs the configured gates on the files a change touches and keeps what
 * belongs to the change (see changed-lines.ts). A deep run that was asked for
 * but could not analyze anything makes the result ERROR, never a clean PASS,
 * and so does a proven gate that crashed (a heuristic one is only listed).
 */
import { GateRunner } from '../gates/runner.js';
import type { Config, DeepOptions, Failure, Report } from '../types/index.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { normalizeScopePatterns } from '../utils/scope.js';
import { deepAnalysisError } from '../utils/deep-status.js';
import { splitByChangedLines } from './changed-lines.js';
import { changedFunctionSpans } from './changed-function-spans.js';
import { withoutGenerated } from './generated-files.js';
import { findingKey, isProven, quietSplit } from './quiet.js';
import { checkId, rememberReported } from './check-outcomes.js';
import { diffFromGit, type DiffSource } from './git-diff.js';
import { diffTestFailures } from './diff-test-findings.js';
import { migrationOrderFailures } from './migration-order.js';
import { orphanFileFailures } from './orphan-files.js';
import { unusedExportFailures } from './unused-exports.js';
import { queryPatternFailures } from './query-patterns.js';
import { optionalParamFailures } from './optional-params.js';
import { duplicateFunctionFailures } from './duplicate-functions.js';
import { loopCopyFailures } from './loop-copies.js';
import { partialFixFailures } from './partial-fixes.js';
import { partialWiringFailures } from './partial-wiring.js';
import { isControlFile } from './trusted-state.js';
import { baseCommit, baseFindings, splitIntroduced } from './baseline.js';

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
    deep?: Omit<DeepOptions, 'focusLines' | 'removedLines' | 'diff'>;
    /** Read dismissals and check outcomes at this commit (the base), not as the change left them. */
    trustedRef?: string;
}

export interface ReviewResult {
    status: 'PASS' | 'FAIL' | 'ERROR';
    findings: Failure[];
    fileFindings: Failure[];
    /** Deep findings elsewhere in a changed file: shown, never blocking. */
    contextFindings: Failure[];
    /** Heuristic findings on changed lines: returned on request, never deciding the verdict (quiet.ts). */
    advisory: Failure[];
    /** Advisory findings from checks this repository keeps dismissing: counted, not listed. */
    muted: number;
    /** Findings a person dismissed as not a bug, and the gates they came from. */
    dismissed: number;
    dismissedByGate: Record<string, number>;
    unlocated: number;
    excludedOutsideChangedLines: number;
    /** Findings the base already had: counted, not reported (baseline.ts). */
    preexisting: number;
    changedLines: Record<string, Set<number>>;
    report: Report | null;
    deepError?: string;
    /** Gates that crashed instead of running; a proven one makes the result ERROR. */
    gateErrors: string[];
    /** rigour.yml or .rigour/ files this change edits: they steer the review, so they are called out. */
    controlFilesChanged: string[];
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
    /** Stable across runs: `rigour dismiss <key>` silences this finding for good. */
    key: string;
    suggestion?: string;
}

export async function reviewChange(input: ReviewInput): Promise<ReviewResult> {
    const diff = input.diff ?? diffFromGit(input.cwd, input.source);
    const changedLines = withoutGenerated(input.cwd, parseDiff(diff));
    const targets = input.files?.length ? input.files : Object.keys(changedLines);
    if (targets.length === 0) {
        return { status: 'PASS', findings: [], fileFindings: [], contextFindings: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {}, unlocated: 0, excludedOutsideChangedLines: 0, preexisting: 0, changedLines, report: null, gateErrors: [], controlFilesChanged: controlFiles(diff) };
    }
    const deep = input.deep ? { ...input.deep, focusLines: changedLinesByFile(changedLines), removedLines: removedByFile(diff), diff } : undefined;
    const report = await new GateRunner(input.config).run(input.cwd, await normalizeScopePatterns(input.cwd, targets), deep);
    const preexisting = await dropPreexisting(input, report, targets);
    if (input.diffTests && deep) report.failures.push(...await diffTestFailures(input.cwd, input.source, deep));
    report.failures.push(...migrationOrderFailures(input.cwd, diff, input.source, input.config));
    report.failures.push(...unusedExportFailures(input.cwd, diff, input.config), ...orphanFileFailures(input.cwd, diff, input.config));
    report.failures.push(
        ...queryPatternFailures(input.cwd, changedLines, input.config),
        ...optionalParamFailures(input.cwd, changedLines, input.config),
        ...duplicateFunctionFailures(input.cwd, changedLines, input.config),
        ...loopCopyFailures(input.cwd, changedLines, input.config),
        ...partialFixFailures(input.cwd, changedLines, input.config),
        ...partialWiringFailures(input.cwd, changedLines, input.config),
    );
    const split = splitByChangedLines(report.failures, changedLines, deep ? changedFunctionSpans(input.cwd, changedLines) : {}, removedByFile(diff));
    const deepError = deepAnalysisError(report);
    const quiet = quietSplit(input.cwd, split.findings, input.config.review?.include_heuristics, input.trustedRef);
    rememberReported(input.cwd, [...quiet.speaking, ...quiet.advisory].map(f => ({ key: findingKey(f), check: checkId(f) })));
    const gateErrors = crashedGates(report);
    const provenCrashed = gateErrors.some(id => isProven({ id } as Failure));
    return {
        status: deepError || provenCrashed ? 'ERROR' : quiet.speaking.length > 0 ? 'FAIL' : 'PASS',
        findings: quiet.speaking,
        advisory: quiet.advisory,
        muted: quiet.muted,
        dismissed: quiet.dismissed,
        dismissedByGate: quiet.dismissedByGate,
        fileFindings: split.fileFindings,
        contextFindings: split.contextFindings,
        unlocated: split.unlocated,
        excludedOutsideChangedLines: split.outside,
        preexisting,
        changedLines,
        report,
        gateErrors,
        controlFilesChanged: controlFiles(diff),
        ...(deepError ? { deepError } : {}),
    };
}

/** Drop the rules' findings the base already had; returns how many. Model findings stay: the model reviews only the change. */
async function dropPreexisting(input: ReviewInput, report: Report, targets: string[]): Promise<number> {
    if (input.config.review?.show_preexisting) return 0;
    const commit = baseCommit(input.cwd, input.source ?? (input.diff ? undefined : { mode: 'working' }));
    const rules = report.failures.filter(f => f.provenance !== 'deep-analysis');
    if (!commit || rules.length === 0) return 0;
    try {
        const { preexisting } = splitIntroduced(rules, await baseFindings(input.cwd, input.config, commit, targets));
        const old = new Set(preexisting);
        report.failures = report.failures.filter(f => !old.has(f));
        return old.size;
    } catch {
        return 0; // the comparison is a courtesy; it never fails a review
    }
}

/** Every path the diff touches (including deletions, which parseDiff drops) that steers Rigour itself. */
function controlFiles(diff: string): string[] {
    const files = new Set<string>();
    for (const match of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
        for (const file of [match[1], match[2]]) if (isControlFile(file)) files.add(file);
    }
    return [...files].sort();
}

function crashedGates(report: Report): string[] {
    return Object.entries(report.summary).filter(([, status]) => status === 'ERROR').map(([id]) => id);
}

/** The JSON shape of a finding, shared by the CLI's --json and the MCP tool. */
export function toReviewFinding(failure: Failure): ReviewFinding {
    return {
        id: failure.id,
        gate: failure.title,
        severity: failure.severity || 'medium',
        provenance: failure.provenance || 'traditional',
        message: failure.details,
        key: findingKey(failure),
        file: failure.files?.[0] || '',
        line: failure.line ?? null,
        ...(failure.anchorLine !== undefined ? { anchor_line: failure.anchorLine } : {}),
        ...(failure.hint ? { suggestion: failure.hint } : {}),
    };
}
