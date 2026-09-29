import { describe, expect, it } from 'vitest';
import { buildCodeReviewPrompt, REVIEW_CATEGORIES } from './code-review-prompt.js';

const context = { file: 'src/a.ts', language: 'typescript', text: 'FILE: src/a.ts\n1| export const a = 1;', ranges: [[1, 1]] as [number, number][], source: '' };

describe('buildCodeReviewPrompt', () => {
    it('includes every category, the rules and the numbered source', () => {
        const prompt = buildCodeReviewPrompt(context);
        for (const c of REVIEW_CATEGORIES) expect(prompt).toContain(`- ${c.key}: ${c.focus}`);
        expect(prompt).toContain('Report only defects you can point to');
        expect(prompt).toContain('1| export const a = 1;');
        expect(prompt).toContain('Review src/a.ts');
    });

    it('allows an empty answer so the model is not pushed to invent findings', () => {
        expect(buildCodeReviewPrompt(context)).toContain('{"findings": []}');
    });

    it('uses unique category keys', () => {
        const keys = REVIEW_CATEGORIES.map(c => c.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});
