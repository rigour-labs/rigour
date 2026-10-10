/**
 * reviewChange: the one review engine behind `rigour review`, the MCP
 * `rigour_review` tool and the GitHub integration.
 *
 * Runs the configured gates on the files a change touches and keeps what
 * belongs to the change (see changed-lines.ts). A deep run that was asked for
 * but could not analyze anything makes the result ERROR, never a clean PASS,
 * and so does a proven gate that crashed (a heuristic one is only listed).
 */
import { spawnSync } from 'child_process';
import { GateRunner, gateOf } from '../gates/runner.js';
import type { Config, DeepOptions, Failure, Report } from '../types/index.js';
import { changedLinesByFile, parseDiff, removedByFile } from '../utils/diff.js';
import { normalizeScopePatterns } from '../utils/scope.js';
import { deepAnalysisError } from '../utils/deep-status.js';
import { splitByChangedLines } from './changed-lines.js';
import { changedFunctionSpans } from './changed-function-spans.js';
import { isGeneratedFile, withoutGenerated } from './generated-files.js';
import { findingKey, isProven, quietSplit } from './quiet.js';
import { checkId, rememberReported } from './check-outcomes.js';
import { diffFromGit, type DiffSource } from './git-diff.js';
import { diffTestFailures, withDiffTestCertainty } from './diff-test-findings.js';
import { migrationOrderFailures } from './migration-order.js';
import { compiledChecksOn } from '../review-learning/compiled-lessons.js';
import { settledChecks, type CoveredLesson } from './settled-checks.js';
import { orphanFileFailures } from './orphan-files.js';
import { unusedExportFailures } from './unused-exports.js';
import { queryPatternFailures } from './query-patterns.js';
import { optionalParamFailures } from './optional-params.js';
import { duplicateFunctionFailures } from './duplicate-functions.js';
import { typedChecks, TYPED_CHECKS, type Redundancy } from './typed/redundancy.js';
import { loopCopyFailures } from './loop-copies.js';
import { partialFixFailures } from './partial-fixes.js';
import { partialWiringFailures } from './partial-wiring.js';
import { isControlFile } from './trusted-state.js';
import { baseCommit, baseFindings, splitIntroduced } from './baseline.js';
import { goalFailures, hasCheckableGoal, parseGoal, type Goal } from '../goal/goal.js';

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
    /** Run the typed checks (review/typed): the project's TypeScript program takes seconds, so at push, in `rigour review` and in a backtest, not at every stop. */
    typed?: boolean;
    /** The pull request's description, when the goal check is on (switches.ts): the change is checked against the goal it declares. */
    goalDescription?: string;
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
    /** The same, by check. A check whose findings were all the base's reads PASS in the report's summary. */
    preexistingByCheck: Record<string, number>;
    /** By check, findings only on lines the change did not touch. A check whose findings were all such reads PASS in the report's summary. */
    outsideChangeByCheck: Record<string, number>;
    /** A diff given with no base whose change HEAD already holds (committed work): nothing was compared, so nothing was dropped as the base's. */
    baseUnknown?: boolean;
    changedLines: Record<string, Set<number>>;
    report: Report | null;
    deepError?: string;
    /** Gates that crashed instead of running; a proven one makes the result ERROR. */
    gateErrors: string[];
    /** rigour.yml or .rigour/ files this change edits: they steer the review, so they are called out. */
    controlFilesChanged: string[];
    /** Candidates for the reviewer to confirm (a nested scan, a property that only leaves through serialisation), from the typed checks. */
    hints: string[];
    /** Why the typed checks could not run on a TypeScript project (`gateErrors` then names `typed-checks-unavailable`). */
    typedError?: string;
    /** The goal the description declared, when the goal check ran on one with something to check. */
    goal?: Goal;
    /** The lessons the team's compiled checks covered on this change: a model reviewer is told so instead of the lesson. */
    covered: CoveredLesson[];
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
    /** How sure the rule is the defect exists, when it says: only `proven` blocks (quiet.ts mustFix). */
    certainty?: 'proven' | 'likely' | 'possible';
}

export async function reviewChange(input: ReviewInput): Promise<ReviewResult> {
    const diff = input.diff ?? diffFromGit(input.cwd, input.source);
    const changedLines = withoutGenerated(input.cwd, parseDiff(diff));
    const targets = input.files?.length ? input.files : Object.keys(changedLines);
    if (targets.length === 0) {
        return { status: 'PASS', findings: [], fileFindings: [], contextFindings: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {}, unlocated: 0, excludedOutsideChangedLines: 0, preexisting: 0, preexistingByCheck: {}, outsideChangeByCheck: {}, changedLines, report: null, gateErrors: [], controlFilesChanged: controlFiles(diff), hints: [], covered: [] };
    }
    // The team's compiled checks run before the deep review, so it is told what they found and which lessons they covered.
    const compiled = compiledChecksOn(input.cwd, changedLines, input.config);
    const deep = input.deep ? { ...input.deep, focusLines: changedLinesByFile(changedLines), removedLines: removedByFile(diff), diff, settled: settledChecks(compiled.failures), covered: compiled.covered } : undefined;
    // The team's `commands:` run at push (toolchain.ts), where a failure blocks; here they would only cost time.
    const report = await new GateRunner({ ...input.config, commands: {} }).run(input.cwd, await normalizeScopePatterns(input.cwd, targets), deep);
    const { preexisting, byCheck: preexistingByCheck = {}, baseUnknown } = await dropPreexisting(input, report, targets);
    const goal = input.goalDescription !== undefined ? parseGoal(input.goalDescription, fileNames(input.cwd, diff)) : undefined;
    if (input.diffTests && deep) report.failures.push(...withDiffTestCertainty(await diffTestFailures(input.cwd, input.source, deep), !!goal?.invariants.length));
    // The review's own checks, each recorded in the summary beside the gates, so a report says everything that ran.
    const reviewCheck = (id: string, key: keyof Config['gates'], failures: Failure[]) => {
        const enabled = (input.config.gates[key] as { enabled?: boolean } | undefined)?.enabled;
        report.summary[id] = !enabled ? 'SKIP' : failures.length ? 'FAIL' : 'PASS';
        report.failures.push(...failures);
    };
    reviewCheck('migration-order', 'migration_order', migrationOrderFailures(input.cwd, diff, input.source, input.config));
    reviewCheck('unused-exports', 'unused_exports', unusedExportFailures(input.cwd, diff, input.config));
    reviewCheck('orphan-files', 'orphan_files', orphanFileFailures(input.cwd, diff, input.config));
    reviewCheck('compiled-lessons', 'compiled_lessons', compiled.failures);
    reviewCheck('query-patterns', 'query_patterns', queryPatternFailures(input.cwd, changedLines, input.config));
    reviewCheck('optional-params', 'optional_params', optionalParamFailures(input.cwd, changedLines, input.config));
    reviewCheck('duplicate-functions', 'duplicate_functions', duplicateFunctionFailures(input.cwd, changedLines, input.config));
    reviewCheck('change-sweep', 'change_sweep', [
        ...loopCopyFailures(input.cwd, changedLines, input.config),
        ...partialFixFailures(input.cwd, changedLines, input.config),
        ...partialWiringFailures(input.cwd, changedLines, input.config),
    ]);
    const typed: Redundancy = input.typed ? typedChecks(input.cwd, changedLines, input.config) : { failures: [], hints: [] };
    if (typed.error) report.summary[TYPED_CHECKS] = 'ERROR'; // a check that could not run is a crashed gate, never a pass
    else if (input.typed) reviewCheck('redundancy', 'redundancy', typed.failures);
    const split = splitByChangedLines(report.failures, changedLines, deep ? changedFunctionSpans(input.cwd, changedLines) : {}, removedByFile(diff));
    const outside = new Set(split.outsideFindings);
    const outsideChangeByCheck = passChecksOnlyLeftOut(report, split.outsideFindings, report.failures.filter(f => !outside.has(f)));
    const deepError = deepAnalysisError(report);
    // The goal's findings are about the change as a whole (a file it should not touch, an item it never did), not a line, so they skip the changed-line split.
    const checkedGoal = goal && hasCheckableGoal(goal) ? goal : undefined;
    const goalFindings = checkedGoal ? goalFailures(checkedGoal, changedLines, diff, file => isGeneratedFile(input.cwd, file)) : [];
    if (checkedGoal) report.summary.goal = goalFindings.length ? 'FAIL' : 'PASS';
    const quiet = quietSplit(input.cwd, [...split.findings, ...goalFindings], input.config.review?.include_heuristics, input.trustedRef);
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
        preexistingByCheck,
        outsideChangeByCheck,
        ...(baseUnknown ? { baseUnknown } : {}),
        changedLines,
        report,
        gateErrors,
        controlFilesChanged: controlFiles(diff),
        hints: typed.hints,
        covered: compiled.covered,
        ...(deepError ? { deepError } : {}),
        ...(typed.error ? { typedError: typed.error } : {}),
        ...(checkedGoal ? { goal: checkedGoal } : {}),
    };
}

/**
 * A check whose findings were all left out of this change's verdict (what the base already had, or lines the change
 * did not touch) passes for it: its summary reads PASS, and the count, by check, says what it left out. A check with
 * any finding still in play keeps FAIL.
 */
function passChecksOnlyLeftOut(report: Report, leftOut: Failure[], kept: Failure[]): Record<string, number> {
    const byCheck: Record<string, number> = {};
    const check = (f: Failure) => gateOf(f) ?? f.id;
    for (const f of leftOut) byCheck[check(f)] = (byCheck[check(f)] ?? 0) + 1;
    const remaining = new Set(kept.map(check));
    for (const id of Object.keys(byCheck)) if (report.summary[id] === 'FAIL' && !remaining.has(id)) report.summary[id] = 'PASS';
    return byCheck;
}

/**
 * Drop the rules' findings the base already had; returns how many. Model findings stay: the model reviews only the change.
 * A diff given with no `--base` is compared with HEAD, which is right for uncommitted work. When HEAD already holds the
 * change (a diff of committed work), HEAD is no base: every finding would look like the base's, so none is dropped and
 * `baseUnknown` says why.
 */
async function dropPreexisting(input: ReviewInput, report: Report, targets: string[]): Promise<{ preexisting: number; byCheck?: Record<string, number>; baseUnknown?: boolean }> {
    if (input.config.review?.show_preexisting) return { preexisting: 0 };
    if (input.diff !== undefined && input.source?.mode !== 'base' && input.source?.mode !== 'since' && headHolds(input.cwd, input.diff)) return { preexisting: 0, baseUnknown: true };
    const commit = baseCommit(input.cwd, input.source ?? (input.diff ? undefined : { mode: 'working' }));
    const rules = report.failures.filter(f => f.provenance !== 'deep-analysis');
    if (!commit || rules.length === 0) return { preexisting: 0 };
    try {
        const { preexisting } = splitIntroduced(rules, await baseFindings(input.cwd, input.config, commit, targets));
        const old = new Set(preexisting);
        report.failures = report.failures.filter(f => !old.has(f));
        return { preexisting: old.size, byCheck: passChecksOnlyLeftOut(report, preexisting, report.failures) };
    } catch {
        return { preexisting: 0 }; // the comparison is a courtesy; it never fails a review
    }
}

/** Whether HEAD already has a file as the diff leaves it (its `index <before>..<after>` blob), read in one `git ls-tree`. */
function headHolds(cwd: string, diff: string): boolean {
    const after = new Map<string, string>();
    for (const m of diff.matchAll(/^diff --git a\/.+? b\/(.+)\n(?:(?!diff --git ).*\n)*?index [0-9a-f]+\.\.([0-9a-f]+)/gm)) {
        if (!/^0+$/.test(m[2])) after.set(m[1], m[2]);
    }
    if (after.size === 0) return false;
    const tree = spawnSync('git', ['ls-tree', '-z', 'HEAD', '--', ...after.keys()], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
    if (tree.status !== 0) return false;
    return tree.stdout.split('\0').some(line => {
        const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
        return !!m && !!after.get(m[2]) && m[1].startsWith(after.get(m[2])!);
    });
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
        ...(failure.certainty ? { certainty: failure.certainty } : {}),
    };
}

/**
 * Whether a bare file name is one the repository has at any depth, or one the change touches (a deleted file too):
 * goal/goal.ts tells `package.json` from `res.json` by it. Undefined outside git. Read once per review.
 */
function fileNames(cwd: string, diff: string): ((name: string) => boolean) | undefined {
    const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) return undefined;
    const touched = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].flatMap(m => [m[1], m[2]]);
    const names = new Set([...result.stdout.split('\0'), ...touched].filter(Boolean).map(file => file.slice(file.lastIndexOf('/') + 1)));
    return name => names.has(name);
}
