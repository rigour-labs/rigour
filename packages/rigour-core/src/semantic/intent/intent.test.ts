import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadIntentCases, runIntentCase, scoreIntent } from './benchmark.js';
import { verdictOf, type Answer, type YesNoModel } from './intent-check.js';

const ROOT = path.resolve(__dirname, '../../../../../benchmarks/intent');

/** Answers from the labels: an oracle, optionally contradicting itself on one read. */
function labelledModel(labels: Record<string, 'optional' | 'required'>, contradict?: string): YesNoModel {
    return {
        async ask(prompt: string): Promise<Answer> {
            const label = Object.keys(labels).find(name => prompt.includes(`Question: If \`${name}\``) || prompt.includes(`result of \`${name}\``));
            if (!label) return null;
            const optional = labels[label] === 'optional';
            const firstQuestion = prompt.includes('Question: If');
            if (label === contradict) return 'yes';
            return firstQuestion === optional ? 'yes' : 'no';
        },
    };
}

describe('verdictOf', () => {
    it('counts only consistent flipped answers', () => {
        expect(verdictOf(['yes', 'no'])).toBe('optional');
        expect(verdictOf(['no', 'yes'])).toBe('required');
        expect(verdictOf(['yes', 'yes'])).toBe('unknown');
        expect(verdictOf(['no', 'no'])).toBe('unknown');
        expect(verdictOf([null, 'no'])).toBe('unknown');
    });
});

describe('intent benchmark with a labelled oracle', () => {
    const cases = loadIntentCases(ROOT);

    it('finds every labelled site, skips the fixed one, and scores the oracle perfectly', async () => {
        const results = await Promise.all(cases.map(bench => runIntentCase(ROOT, bench, labelledModel(bench.labels))));
        const score = scoreIntent(results);
        expect(score.finderErrors).toEqual([]);
        expect(score.falsePositives).toBe(0);
        expect(score.falseNegatives).toBe(0);
        expect(score.rawCorrect).toBe(score.rawTotal);
    });

    it('drops a read whose answers contradict each other instead of guessing', async () => {
        const bench = cases.find(c => c.name === 'dashboard')!;
        const result = await runIntentCase(ROOT, bench, labelledModel(bench.labels, 'getRecommendedCourses'));
        expect(result.verdicts.find(v => v.read.label === 'getRecommendedCourses')?.verdict).toBe('unknown');
        expect(result.findings).toBe(0);
    });
});
