import { describe, expect, it } from 'vitest';
import type { Failure } from '@rigour-labs/core';
import { buildCiReviewSummary, filterChangedLineFailures, renderGithubSummary } from './review-summary.js';

function failure(id: string, severity: Failure['severity'], file: string, line: number, details: string): Failure {
    return { id, title: id, details, hint: details, severity, provenance: 'traditional', files: [file], line };
}

describe('GitHub change review summary', () => {
    it('prioritizes severe findings and never includes raw secret-bearing messages', () => {
        const failures = [
            failure('style-drift', 'low', 'src/a.ts', 3, 'ordinary style'),
            failure('security-patterns', 'critical', 'src/shell.ts', 8, 'API_KEY=secret-value-that-must-not-appear'),
            failure('logic-drift', 'medium', 'src/logic.ts', 5, 'changed operator'),
        ];
        const summary = buildCiReviewSummary(failures, 5, { 'src/a.ts': new Set([3]), 'src/shell.ts': new Set([8]) });
        const markdown = renderGithubSummary(summary);
        expect(summary.findings.map(item => item.rule)).toEqual(['security-patterns', 'logic-drift', 'style-drift']);
        expect(summary.severity).toEqual({ critical: 1, high: 0, medium: 1, low: 1 });
        expect(summary.excluded_outside_changed_lines).toBe(2);
        expect(summary.changed_lines).toBe(2);
        expect(markdown).toContain('Trace the input and sink');
        expect(markdown).not.toContain('secret-value-that-must-not-appear');
    });

    it('caps output and escapes untrusted path text', () => {
        const failures = Array.from({ length: 8 }, (_, i) =>
            failure('style-drift', 'low', `src/bad\`\n${i}.ts`, i + 1, 'untrusted'));
        const summary = buildCiReviewSummary(failures, 8, {});
        const markdown = renderGithubSummary(summary);
        expect(summary.findings).toHaveLength(5);
        expect(summary.truncated).toBe(3);
        expect(markdown).not.toContain('bad`');
        expect(markdown).toContain('3 more finding(s)');
    });

    it('does not imply a clean repository when changed lines pass', () => {
        const markdown = renderGithubSummary(buildCiReviewSummary([], 20, {}));
        expect(markdown).toContain('No findings on changed lines');
        expect(markdown).toContain('does not assess the full repository');
    });

    it('abstains from attributing file-level findings to changed line one', () => {
        const withLine = failure('security-patterns', 'high', 'src/a.ts', 5, 'specific line');
        const fileLevel = { ...failure('AST_COMPLEXITY', 'medium', 'src/a.ts', 1, 'whole file'), line: undefined };
        const { failures, unlocated } = filterChangedLineFailures(
            [withLine, fileLevel], { 'src/a.ts': new Set([1, 5]) });
        expect(failures).toEqual([withLine]);
        expect(unlocated).toBe(1);
        const summary = buildCiReviewSummary(failures, 2, { 'src/a.ts': new Set([1, 5]) }, unlocated);
        expect(renderGithubSummary(summary)).toContain('file-level finding(s) lacked a changed-line location');
    });
});
