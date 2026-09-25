import type { Failure } from '@rigour-labs/core';

type Severity = 'critical' | 'high' | 'medium' | 'low';
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const MAX_FINDINGS = 5;

export interface CiFinding {
    rule: string;
    severity: Severity;
    file: string;
    line: number;
    reason: string;
    next_step: string;
}

export interface CiReviewSummary {
    schema_version: 1;
    scope: 'changed_lines';
    changed_files: number;
    changed_lines: number;
    findings_count: number;
    excluded_outside_changed_lines: number;
    unlocated_omitted: number;
    severity: Record<Severity, number>;
    findings: CiFinding[];
    truncated: number;
}

function safeLabel(value: string, max = 120): string {
    return value.replace(/[^a-zA-Z0-9_./: -]/g, '_').slice(0, max);
}

function severityOf(failure: Failure): Severity {
    return SEVERITIES.includes(failure.severity as Severity) ? failure.severity as Severity : 'medium';
}

function guidance(rule: string): { reason: string; next_step: string } {
    if (rule === 'logic-drift') return {
        reason: 'Behavior differs from the fixed Git base; this is a review signal, not proof of a defect.',
        next_step: 'Confirm the intended boundary behavior and its tests.',
    };
    if (rule === 'style-drift') return {
        reason: 'A comparable naming or error-handling convention differs from the project baseline.',
        next_step: 'Check the local convention and framework context before changing code.',
    };
    if (rule === 'security-patterns') return {
        reason: 'A security rule matched code on a changed line.',
        next_step: 'Trace the input and sink; verify the risk before merging.',
    };
    if (rule === 'hallucinated-imports') return {
        reason: 'An imported path or package could not be resolved in the project.',
        next_step: 'Check the source file, package manifest, and runtime resolution.',
    };
    if (rule === 'frontend-secret-exposure') return {
        reason: 'A secret-related reference appears in a possible frontend bundle path.',
        next_step: 'Trace whether the value can reach client-side output.',
    };
    if (rule === 'phantom-apis') return {
        reason: 'An API name did not match the known library or runtime surface.',
        next_step: 'Verify the API against the installed version and its types.',
    };
    return {
        reason: 'A quality gate matched a changed line.',
        next_step: 'Inspect the full JSON report and run rigour explain for evidence.',
    };
}

export function buildCiReviewSummary(
    failures: Failure[],
    allFailuresCount: number,
    changedLines: Record<string, Set<number>>,
    unlocatedOmitted = 0,
): CiReviewSummary {
    const severity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const failure of failures) severity[severityOf(failure)]++;
    const ordered = failures.map(failure => {
        const rule = safeLabel(failure.id || 'unknown', 80);
        return {
            rule,
            severity: severityOf(failure),
            file: safeLabel(failure.files?.[0] || '', 200),
            line: failure.line ?? 1,
            ...guidance(rule),
        };
    }).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
        || a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
    const findings = ordered.slice(0, MAX_FINDINGS);
    return {
        schema_version: 1,
        scope: 'changed_lines',
        changed_files: Object.keys(changedLines).length,
        changed_lines: Object.values(changedLines).reduce((count, lines) => count + lines.size, 0),
        findings_count: failures.length,
        excluded_outside_changed_lines: Math.max(0, allFailuresCount - failures.length - unlocatedOmitted),
        unlocated_omitted: unlocatedOmitted,
        severity,
        findings,
        truncated: Math.max(0, failures.length - findings.length),
    };
}

export function renderGithubSummary(summary: CiReviewSummary): string {
    const lines = [
        '### Rigour change review',
        '',
        `**${summary.findings_count} finding(s)** on changed lines across ${summary.changed_files} file(s) and ${summary.changed_lines} added line(s).`,
        `Critical ${summary.severity.critical} · High ${summary.severity.high} · Medium ${summary.severity.medium} · Low ${summary.severity.low}`,
        '',
    ];
    if (summary.findings_count === 0) lines.push('No findings on changed lines. This does not assess the full repository.');
    for (const finding of summary.findings) {
        lines.push(`- **${finding.severity.toUpperCase()} · ${finding.rule}** \`${finding.file}:${finding.line}\``);
        lines.push(`  - Why: ${finding.reason}`);
        lines.push(`  - Next: ${finding.next_step}`);
    }
    if (summary.truncated) lines.push(`- ${summary.truncated} more finding(s) are in the JSON report.`);
    if (summary.excluded_outside_changed_lines) {
        lines.push('', `${summary.excluded_outside_changed_lines} finding(s) outside changed lines were excluded from this review.`);
    }
    if (summary.unlocated_omitted) {
        lines.push(`${summary.unlocated_omitted} file-level finding(s) lacked a changed-line location and remain in the full scan.`);
    }
    return lines.join('\n');
}

export function filterChangedLineFailures(
    failures: Failure[],
    changedLines: Record<string, Set<number>>,
): { failures: Failure[]; unlocated: number } {
    let unlocated = 0;
    const matched = failures.filter(failure => {
        if (failure.line === undefined || !failure.files?.length) {
            unlocated++;
            return false;
        }
        return failure.files.some(file => changedLines[file]?.has(failure.line as number));
    });
    return { failures: matched, unlocated };
}
