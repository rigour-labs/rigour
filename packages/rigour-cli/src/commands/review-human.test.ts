import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Failure, QualityReceipt, ReviewResult } from '@rigour-labs/core';
import { printHuman, type HumanContext } from './review-human.js';

let dir: string;
let out: string[];

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-human-'));
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

const finding = (n: number, over: Partial<Failure> = {}): Failure => ({
    id: 'unused-export', title: `export f${n} is used nowhere`, details: '', files: ['src/a.ts'], line: n, hint: 'Remove the export.', ...over,
} as Failure);

const result = (over: Partial<ReviewResult> = {}): ReviewResult => ({
    status: 'PASS', findings: [], fileFindings: [], contextFindings: [], advisory: [], muted: 0, dismissed: 0, dismissedByGate: {},
    unlocated: 0, excludedOutsideChangedLines: 0, preexisting: 0, preexistingByCheck: {}, changedLines: { 'src/a.ts': new Set([1]), 'src/b.ts': new Set([2]) },
    report: { status: 'PASS', failures: [] } as never, gateErrors: [], controlFilesChanged: [], hints: [], covered: [], ...over,
});

const receipt = (over: Partial<QualityReceipt> = {}): QualityReceipt => ({
    functions: 3, reviewed: 0, changedSinceReview: 0, lowRisk: 1, notCovered: [{ file: 'src/a.ts', function: 'f', start: 1, score: 4 }],
    reviewers: {}, otherFiles: 0, setAside: 0, ...over,
} as QualityReceipt);

const show = (r: ReviewResult, over: Partial<HumanContext> = {}) => {
    printHuman(r, { cwd: dir, scope: 'this branch against main', commits: 10, ms: 3200, receipt: null, ...over });
    return out.join('\n');
};

describe('rigour review, as a person reads it', () => {
    it('says what it reviewed, then the verdict', () => {
        const text = show(result());
        expect(text).toContain('Rigour reviewed this branch against main: 10 commits, 2 files, 3 s.');
        expect(text).toContain('✔ Nothing to fix in what this changed.');
    });

    it('lists at most five findings with where, what and the fix, and points at the rest', () => {
        const text = show(result({ status: 'FAIL', findings: [1, 2, 3, 4, 5, 6, 7].map(n => finding(n)) }));
        expect(text).toContain('✘ 7 things to fix before this is ready');
        expect(text).toContain('src/a.ts:5  export f5 is used nowhere');
        expect(text).not.toContain('export f6');
        expect(text).toContain('→ Remove the export.');
        expect(text).toContain('rigour dismiss');
        expect(text).toContain('…and 2 more: rigour review --all');
    });

    it('lists every finding with --all', () => {
        const text = show(result({ status: 'FAIL', findings: [1, 2, 3, 4, 5, 6, 7].map(n => finding(n)) }), { all: true });
        expect(text).toContain('export f7 is used nowhere');
        expect(text).not.toContain('--all');
    });

    it('is not finished, with the project\'s own install command, when the type checks need dependencies', () => {
        fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
        const text = show(result({ status: 'ERROR', gateErrors: ['typed-checks-unavailable'], typedError: "tsconfig.json cannot be loaded: File 'x' not found." }));
        expect(text).toContain('⚠ Not finished: the type checks need your dependencies installed');
        expect(text).toContain('Run pnpm install, then rigour review again. Everything else found nothing.');
        expect(text).not.toContain('Nothing to fix');
    });

    it('names a check that could not run for another reason', () => {
        fs.mkdirSync(path.join(dir, 'node_modules'));
        const text = show(result({ status: 'ERROR', gateErrors: ['typed-checks-unavailable'], typedError: 'tsconfig.json cannot be loaded: bad JSON' }));
        expect(text).toContain('⚠ Not finished: typed-checks-unavailable could not run (tsconfig.json cannot be loaded: bad JSON)');
    });

    it('keeps notes and old-code issues to one quiet line each', () => {
        const text = show(result({ advisory: [finding(1)], fileFindings: [finding(2)], preexisting: 12, excludedOutsideChangedLines: 3 }));
        expect(text).toContain('Also seen, never blocking: 2 notes (rigour review --notes)');
        expect(text).toContain('Not shown: 15 issues the code already had before this change');
        expect(text).not.toContain('export f1');
        expect(show(result({ advisory: [finding(1)] }), { notes: true })).toContain('src/a.ts:1  export f1 is used nowhere');
    });

    it('says when a diff was compared with no base, so old-code issues are shown', () => {
        expect(show(result({ baseUnknown: true }))).toContain('Compared with no base: HEAD already holds this diff');
        out = [];
        expect(show(result({}))).not.toContain('Compared with no base');
    });

    it('counts the hints a person should confirm, and lists them with --notes', () => {
        const hint = 'nested-scan src/a.ts:9: match() scans its `rows` argument and is called inside a loop; confirm the sizes or index the inner collection once';
        expect(show(result({ hints: [hint] }))).toContain('To confirm by hand: 1 hint (rigour review --notes)');
        out = [];
        expect(show(result({ hints: [hint] }), { notes: true })).toContain(`  ${hint}`);
    });

    it('hides the receipt until agents have reviewed something, unless asked', () => {
        expect(show(result(), { receipt: receipt() })).not.toContain('Quality receipt');
        out = [];
        expect(show(result(), { receipt: receipt(), showReceipt: true })).toContain('Quality receipt');
        out = [];
        expect(show(result(), { receipt: receipt({ reviewed: 1 }) })).toContain('Quality receipt');
    });

    it('offers setup once, only where Rigour is not set up', () => {
        expect(show(result())).toContain('Next: rigour setup checks this while your agent works and before every push.');
        out = [];
        fs.writeFileSync(path.join(dir, 'rigour.yml'), 'version: 1\n');
        expect(show(result())).not.toContain('Next:');
    });

    it('says so when there is nothing to review', () => {
        expect(show(result({ report: null }))).toBe('No changes to review.');
    });
});
