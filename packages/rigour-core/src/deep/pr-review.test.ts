import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReply, InferenceProvider } from '../inference/types.js';
import { verifyCodeFindings } from './code-verifier.js';
import { diffSections } from './pr-diff.js';
import { buildPrPrompt, reviewPullRequest } from './pr-review.js';

const DIFF = [
    'diff --git a/src/send.ts b/src/send.ts',
    '--- a/src/send.ts',
    '+++ b/src/send.ts',
    '@@ -10,3 +10,3 @@ export function send(row) {',
    '   const headers = {};',
    "-  const cls = row.email_class;",
    "+  const cls = 'transactional';",
    '   return deliver(row, cls);',
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/render.ts b/src/render.ts',
    '--- a/src/render.ts',
    '+++ b/src/render.ts',
    '@@ -1,1 +1,2 @@',
    ' export function render(row) {',
    '+  return row.email_class;',
].join('\n');

describe('diffSections', () => {
    it('numbers new-side lines, marks removals, and leaves lockfiles out', () => {
        const sections = diffSections(DIFF);
        expect(sections.map(s => s.file)).toEqual(['src/send.ts', 'src/render.ts']);
        expect(sections[0].text).toContain("   11 +   const cls = 'transactional';");
        expect(sections[0].text).toContain("      -   const cls = row.email_class;");
        expect(sections[0].text).toContain('   12     return deliver(row, cls);');
        expect(sections[1].addedLines).toBe(1);
    });
});

describe('buildPrPrompt', () => {
    it('puts the risky files first and points at the riskiest functions', () => {
        const { prompt } = buildPrPrompt({ cwd: '.', diff: DIFF, focus: [{ file: 'src/render.ts', function: 'render', start: 1, questions: ['Do callers still get a class?'] }], prBody: 'Read the class live.' });
        expect(prompt.indexOf('FILE src/render.ts')).toBeLessThan(prompt.indexOf('FILE src/send.ts'));
        expect(prompt).toContain('- src/render.ts:1 `render`: Do callers still get a class?');
        expect(prompt).toContain('PR DESCRIPTION (what the author intended):\nRead the class live.');
        expect(prompt).not.toContain('pnpm-lock');
    });
});

describe('reviewPullRequest', () => {
    let repo: string;
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-review-'));
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/send.ts'), Array.from({ length: 20 }, (_, i) => i === 10 ? "  const cls = 'transactional';" : `// ${i + 1}`).join('\n'));
        fs.writeFileSync(path.join(repo, 'src/render.ts'), 'export function render(row) {\n  return row.email_class;\n}\n');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('reviews the PR in one conversation and grounds a cross-file finding in the files it names', async () => {
        const replies: ChatReply[] = [
            { text: '', toolCalls: [{ id: 'r', name: 'read_file', arguments: { path: 'src/render.ts' } }] },
            { text: JSON.stringify({ findings: [
                { category: 'consistency', severity: 'high', file: 'src/send.ts', line: 11, description: '`cls` is hard-coded while `render` reads `email_class` live.', suggestion: 's', confidence: 0.9 },
                { category: 'correctness', severity: 'high', file: 'src/send.ts', line: 11, description: '`invented_symbol` is never set.', suggestion: 's', confidence: 0.9 },
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
        expect(kept.map(f => f.description)).toEqual(['`cls` is hard-coded while `render` reads `email_class` live.']);
        expect(rejected).toEqual({ ungrounded_identifier: 1 });
    });
});
