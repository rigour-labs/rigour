import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReply, InferenceProvider } from '../inference/types.js';
import { verifyCodeFindings } from './code-verifier.js';
import { diffSections } from './pr-diff.js';
import { buildPrPrompt, reviewPullRequest } from './pr-review.js';

const DIFF = [
    'diff --git a/src/invoice.ts b/src/invoice.ts',
    '--- a/src/invoice.ts',
    '+++ b/src/invoice.ts',
    '@@ -10,3 +10,3 @@ export function invoice(row) {',
    '   const headers = {};',
    "-  const cls = row.currency;",
    "+  const cls = 'USD';",
    '   return deliver(row, cls);',
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/price.ts b/src/price.ts',
    '--- a/src/price.ts',
    '+++ b/src/price.ts',
    '@@ -1,1 +1,2 @@',
    ' export function price(row) {',
    '+  return row.currency;',
].join('\n');

describe('diffSections', () => {
    it('numbers new-side lines, marks removals, and leaves lockfiles out', () => {
        const sections = diffSections(DIFF);
        expect(sections.map(s => s.file)).toEqual(['src/invoice.ts', 'src/price.ts']);
        expect(sections[0].text).toContain("   11 +   const cls = 'USD';");
        expect(sections[0].text).toContain("      -   const cls = row.currency;");
        expect(sections[0].text).toContain('   12     return deliver(row, cls);');
        expect(sections[1].addedLines).toBe(1);
    });
});

describe('buildPrPrompt', () => {
    it('puts the risky files first and points at the riskiest functions', () => {
        const { prompt } = buildPrPrompt({ cwd: '.', diff: DIFF, focus: [{ file: 'src/price.ts', function: 'price', start: 1, questions: ['Do callers still get a currency?'] }], prBody: 'Read the currency live.' });
        expect(prompt.indexOf('FILE src/price.ts')).toBeLessThan(prompt.indexOf('FILE src/invoice.ts'));
        expect(prompt).toContain('- src/price.ts:1 `price`: Do callers still get a currency?');
        expect(prompt).toContain('PR DESCRIPTION (what the author intended):\nRead the currency live.');
        expect(prompt).not.toContain('pnpm-lock');
    });
});

describe('reviewPullRequest', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/invoice.ts'), Array.from({ length: 20 }, (_, i) => i === 10 ? "  const cls = 'USD';" : `// ${i + 1}`).join('\n'));
        fs.writeFileSync(path.join(repo, 'src/price.ts'), 'export function price(row) {\n  return row.currency;\n}\n');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('reviews the PR in one conversation and grounds a cross-file finding in the files it names', async () => {
        const replies: ChatReply[] = [
            { text: '', toolCalls: [{ id: 'r', name: 'read_file', arguments: { path: 'src/price.ts' } }] },
            { text: JSON.stringify({ findings: [
                { category: 'consistency', severity: 'high', file: 'src/invoice.ts', line: 11, description: '`cls` is hard-coded while `price` reads `currency` live.', suggestion: 's', confidence: 0.9 },
                { category: 'correctness', severity: 'high', file: 'src/invoice.ts', line: 11, description: '`invented_symbol` is never set.', suggestion: 's', confidence: 0.9 },
            ] }), toolCalls: [] },
        ];
        let conversations = 0;
        const provider: InferenceProvider = {
            name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {}, analyze: async () => '',
            chat: async (messages) => { if (messages.length === 1) conversations++; return replies.shift()!; },
        };
        const result = await reviewPullRequest(provider, { cwd: repo, diff: DIFF, focus: [] }, {});
        expect(conversations).toBe(1);
        expect(result.toolCalls).toBe(1);
        const rejected = {};
        const kept = verifyCodeFindings(result.findings, result.contexts, rejected);
        expect(kept.map(f => f.description)).toEqual(['`cls` is hard-coded while `price` reads `currency` live.']);
        expect(rejected).toEqual({ ungrounded_identifier: 1 });
    });

    it('tells the model what the checks already found; drops its finding of the same kind there, and keeps a different one, tagged', async () => {
        const settled = [{ file: 'src/invoice.ts', line: 11, title: 'Security: XSS', kind: 'security-patterns' }];
        expect(buildPrPrompt({ cwd: repo, diff: DIFF, focus: [], settled }).prompt).toContain("## Already found by Rigour's checks on this change: do not report them again\n- src/invoice.ts:11 Security: XSS");
        const covered = [{ checkId: 'c-L1', lessonId: 'L1', message: 'never hard-code a currency' }];
        expect(buildPrPrompt({ cwd: repo, diff: DIFF, focus: [], covered }).prompt).toContain('- covered by compiled check c-L1 for lesson L1: never hard-code a currency');
        expect(buildPrPrompt({ cwd: repo, diff: DIFF, focus: [] }).prompt).not.toContain('covered by compiled check');
        const provider: InferenceProvider = {
            name: 'fake', isAvailable: async () => true, setup: async () => {}, dispose: () => {}, analyze: async () => '',
            chat: async () => ({ text: JSON.stringify({ findings: [
                { category: 'security', severity: 'high', file: 'src/invoice.ts', line: 11, description: '`cls` reaches the page unescaped.', suggestion: 's', confidence: 0.9 },
                { category: 'correctness', severity: 'high', file: 'src/invoice.ts', line: 11, description: '`cls` is hard-coded to one currency.', suggestion: 's', confidence: 0.9 },
                { category: 'correctness', severity: 'high', file: 'src/price.ts', line: 2, description: '`price` returns `currency`, not a number.', suggestion: 's', confidence: 0.9 },
            ] }), toolCalls: [] }),
        };
        const result = await reviewPullRequest(provider, { cwd: repo, diff: DIFF, focus: [], settled }, {});
        expect(result.findings.map(f => [`${f.file}:${f.line}`, f.category, f.alsoAt])).toEqual([
            ['src/invoice.ts:11', 'correctness', 'Security: XSS'],
            ['src/price.ts:2', 'correctness', undefined],
        ]);
    });
});
