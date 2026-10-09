/**
 * What Rigour's checks already found on a change, as a model reviewer is told it: settled, never to be reported again. The judge (reviewer/context.ts) and the deep PR review (deep/pr-review.ts) both say it this way,
 * so neither spends a model's turn on what a free check proves.
 */

/** A check's finding where it sits; `kind` is the check's id. */
export interface SettledCheck { file: string; line?: number; title: string; kind?: string }

/**
 * The model reviewer's categories (deep/code-review-prompt.ts) each check's findings belong to: a model finding of one of
 * them, on a check's line, is the check's finding said again. A check missing here matches no category, so a model finding
 * on its line is always kept.
 */
const CHECK_CATEGORIES: Record<string, string[]> = {
    'security-patterns': ['security'],
    'deprecated-apis': ['security', 'api_misuse'],
    'semantic-bugs': ['correctness'],
    'hallucinated-imports': ['api_misuse', 'correctness'],
    'promise-safety': ['error_handling'],
    'offset-paging': ['scalability'],
    'unbounded-window': ['scalability'],
};

/** What a model finding is against the settled checks: the same issue as one (drop it), or on a line one flags (keep it, say so). */
export function againstSettled(finding: { file: string; line?: number; category: string }, settled: SettledCheck[]): { same: boolean; alsoAt: string[] } {
    const here = settled.filter(c => c.line !== undefined && c.file === finding.file && c.line === finding.line);
    return { same: here.some(c => !!c.kind && (CHECK_CATEGORIES[c.kind] ?? []).includes(finding.category)), alsoAt: here.map(c => c.title) };
}

/** The findings on a change's lines (`focusLines`, per file); every finding when there is no change to scope to. */
export function onChangedLines<F extends { files?: string[]; line?: number }>(findings: F[], focusLines: Record<string, number[]> | undefined): F[] {
    if (!focusLines) return findings;
    return findings.filter(f => {
        const lines = focusLines[f.files?.[0] ?? ''];
        return !!lines && (f.line === undefined || lines.includes(f.line));
    });
}

/** The most settled items (findings, dismissals, refuted points) a prompt lists. */
export const MAX_SETTLED = 40;

/** Findings as settled checks: their first file, line and title. */
export function settledChecks(findings: Array<{ id?: string; files?: string[]; line?: number; title: string }>): SettledCheck[] {
    return findings.map(f => ({ file: f.files?.[0] ?? '?', ...(f.line ? { line: f.line } : {}), title: f.title, ...(f.id ? { kind: f.id } : {}) }));
}

/** One line per finding: `file:line title`. */
export function settledLine(check: SettledCheck): string {
    return `${check.file}${check.line ? `:${check.line}` : ''} ${check.title}`;
}

/** The prompt section; empty when there is nothing settled. */
export function settledSection(lines: string[]): string {
    return lines.length ? `## Already found by Rigour's checks on this change: do not report them again\n${lines.slice(0, MAX_SETTLED).map(c => `- ${c}`).join('\n')}` : '';
}

/** A lesson a compiled check covered on this change: the check ran on its files, and its findings are settled. */
export interface CoveredLesson { checkId: string; lessonId: string; message: string }

/** A model reviewer's lessons without those a compiled check covered on this change: the check said them for free. */
export function withoutCovered<L extends { id: string }>(lessons: L[], covered: CoveredLesson[]): L[] {
    const ids = new Set(covered.map(c => c.lessonId));
    return ids.size ? lessons.filter(l => !ids.has(l.id)) : lessons;
}

/** The prompt section saying which lessons a compiled check covered instead; empty when none did. */
export function coveredSection(covered: CoveredLesson[]): string {
    return covered.length ? `## Lessons the team's compiled checks covered on this change (their findings are listed as already found)\n${covered.map(c => `- covered by compiled check ${c.checkId} for lesson ${c.lessonId}: ${c.message}`).join('\n')}` : '';
}
