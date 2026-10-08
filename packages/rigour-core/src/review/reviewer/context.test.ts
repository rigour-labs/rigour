import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildContext, dismissedAs, type ReviewDismissal } from './context.js';
import type { OpenItem } from './verdict.js';

const dismissal: ReviewDismissal = { id: 'abcdef0123', file: 'src/x.ts', line: 40, class: 'correctness', issue: 'cache key built from user id may collide', reason: 'ids are unique per tenant', at: '2026-10-06' };
const finding = (over: Partial<OpenItem>): OpenItem => ({ id: 'ffff000011', kind: 'finding', class: 'correctness', file: 'src/x.ts', line: 40, issue: 'cache key built from the user id may collide', consequence: 'two users share an entry', ...over });

describe('a dismissal', () => {
    it('covers the same finding re-worded nearby', () => {
        expect(dismissedAs(finding({}), [dismissal])).toBe(dismissal);
        expect(dismissedAs(finding({ line: 42, issue: 'the cache key built from user id may collide' }), [dismissal])).toBe(dismissal);
        expect(dismissedAs(finding({ id: 'abcdef0123', issue: 'anything at all' }), [dismissal])).toBe(dismissal); // its own id
    });

    it('never hides a different bug, even on the same line and in the same class', () => {
        expect(dismissedAs(finding({ issue: 'cache entry never invalidated when the user changes' }), [dismissal])).toBeUndefined();
        expect(dismissedAs(finding({ line: 42, issue: 'cache entry never invalidated when user id changes' }), [dismissal])).toBeUndefined();
        expect(dismissedAs(finding({ line: 80 }), [dismissal])).toBeUndefined(); // far away
        expect(dismissedAs(finding({ class: 'production-cost' }), [dismissal])).toBeUndefined();
        expect(dismissedAs({ ...finding({}), kind: 'prior' }, [dismissal])).toBeUndefined(); // a human's point is never dismissed this way
    });
});

describe('what the judges are told the team knows', () => {
    it('shows verified lessons by default, candidates too with all, none when off, each with the words it came from', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'context-'));
        try {
            const lesson = { file: 'src/a.ts', symbols: ['save'], createdAt: '', updatedAt: '' };
            fs.mkdirSync(path.join(repo, '.rigour'));
            fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [
                { ...lesson, id: 'v', text: 'Make every save idempotent on retry.', state: 'verified', evidence: [{ pr: 3, comment: 'a', author: 'p', said: 'A retry here saves twice.' }, { pr: 4, comment: 'b', author: 'p' }] },
                { ...lesson, id: 'c', text: 'Log the save id on failure.', state: 'candidate', evidence: [{ pr: 5, comment: 'c', author: 'p' }] },
            ] }));
            const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+export const save = 1;\n';
            const told = (lessons?: 'verified' | 'all' | 'off') => buildContext({ cwd: repo, stateRoot: repo, dismissals: [], diff, router: undefined, lessons, previousPanel: undefined, touched: new Set(), docs: [], checks: [] }).text;
            expect(told()).toContain('src/a.ts: Make every save idempotent on retry. (in their words: "A retry here saves twice.") (acted on in PR #3, #4)');
            expect(told()).not.toContain('Log the save id');
            expect(told('all')).toContain('Log the save id on failure.');
            expect(told('off')).not.toContain('idempotent');
            fs.writeFileSync(path.join(repo, 'AGENTS.md'), '- Every call to `save` in `src/a.ts` must be idempotent on retry.\n');
            expect(told()).toMatch(/## Rules this repository wrote for itself[^\n]*\n- \[[0-9a-f]{10}\] \(AGENTS\.md, requirement\) Every call to `save` in `src\/a\.ts` must be idempotent on retry\./);
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});
