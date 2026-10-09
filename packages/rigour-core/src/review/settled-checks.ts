/**
 * What Rigour's checks already found on a change, as a model reviewer is told it: settled, blocking on their own, never
 * to be reported again. The judge (reviewer/context.ts) and the deep PR review (deep/pr-review.ts) both say it this way,
 * so neither spends a model's turn on what a free check proves.
 */

/** A check's finding where it sits. */
export interface SettledCheck { file: string; line?: number; title: string }

/** The most settled items (findings, dismissals, refuted points) a prompt lists. */
export const MAX_SETTLED = 40;

/** Findings as settled checks: their first file, line and title. */
export function settledChecks(findings: Array<{ files?: string[]; line?: number; title: string }>): SettledCheck[] {
    return findings.map(f => ({ file: f.files?.[0] ?? '?', ...(f.line ? { line: f.line } : {}), title: f.title }));
}

/** One line per finding: `file:line title`. */
export function settledLine(check: SettledCheck): string {
    return `${check.file}${check.line ? `:${check.line}` : ''} ${check.title}`;
}

/** The prompt section; empty when there is nothing settled. */
export function settledSection(lines: string[]): string {
    return lines.length ? `## Already found by Rigour's checks: they block on their own, so do not report them again\n${lines.slice(0, MAX_SETTLED).map(c => `- ${c}`).join('\n')}` : '';
}
