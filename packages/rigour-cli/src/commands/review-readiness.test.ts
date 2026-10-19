import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readiness, type ReviewResult } from '@rigour-labs/core';
import { printReadiness, readinessSummary } from './review-readiness.js';
import { buildCiReviewSummary, renderGithubSummary } from './review-summary.js';

let out: string[];
beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
});
afterEach(() => vi.restoreAllMocks());

const review = (summary: Record<string, string>, over: Partial<ReviewResult> = {}): ReviewResult => ({
    status: 'PASS', findings: [], fileFindings: [], contextFindings: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {},
    unlocated: 0, excludedOutsideChangedLines: 0, preexisting: 0, preexistingByCheck: {}, outsideChangeByCheck: {}, changedLines: {},
    report: { status: 'PASS', failures: [], summary, stats: {} } as never, gateErrors: [], controlFilesChanged: [], hints: [], covered: [], blockingByCheck: {}, ...over,
});

const DESCRIPTION = '## Acceptance criteria\n- [ ] refunds over the charge are refused\n';

describe('readiness in rigour review', () => {
    it('prints the line, then one row per category with not verified named', () => {
        printReadiness(readiness({ review: review({ 'semantic-bugs': 'PASS', 'migration-order': 'SKIP' }), receipt: null, description: DESCRIPTION, reviewerAsked: false }), false, 120);
        expect(out[0]).toBe('Technically ready: ready (model review not run; 1 check not run) · Product ready: unknown (not checked; 1 of 1 criterion not verified; model review not run)');
        expect(out).toContain('  checks               1 verified · not verified: migration-order (not run)');
        expect(out).toContain('  team rules           not verified: team rules (model review not run)');
        expect(out).toContain('  acceptance criteria  not verified: refunds over the charge are refused (not checked)');
    });

    it('is unknown, never ready, when the review could not run a check', () => {
        printReadiness(readiness({ review: review({ 'typed-checks': 'ERROR' }, { status: 'ERROR', gateErrors: ['typed-checks'] }), receipt: null, reviewerAsked: false }), false, 120);
        expect(out[0]).toMatch(/^Technically ready: unknown \(could not run: typed-checks/);
        expect(out).toContain('  checks               not verified: typed-checks (could not run)');
    });

    it('wraps a row past the terminal width, with nothing dropped', () => {
        printReadiness(readiness({ review: review({ 'semantic-bugs': 'PASS', 'migration-order': 'SKIP' }), receipt: null, description: DESCRIPTION, reviewerAsked: false }), false, 64);
        expect(out.every(line => line.length <= 64 || line.startsWith('Technically ready'))).toBe(true);
        expect(out).toContain('                       not verified: migration-order (not run)');
    });

    it('adds the same line and table to the GitHub summary', () => {
        const r = readiness({ review: review({ 'semantic-bugs': 'PASS' }), receipt: null, reviewerAsked: true });
        const markdown = renderGithubSummary(buildCiReviewSummary([], 0, {})) + readinessSummary(r);
        expect(markdown).toContain('**Technically ready: unknown (model review asked for, not run) · Product ready: unknown (no acceptance criteria;');
        expect(markdown).toContain('| Coverage | Verified | Failed | Noted | Not verified |');
        expect(markdown).toContain('| lessons | 0 | — | — | other team lessons (model review not run) |');
    });
});
