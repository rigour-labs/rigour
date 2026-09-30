import path from 'path';
import { describe, expect, it } from 'vitest';
import { CANDIDATE_RULES, ECOSYSTEM_RULES } from './rules/ecosystem/index.js';
import { loadCases, runCase } from './benchmark.js';

const ROOT = path.resolve(__dirname, '../../../../benchmarks/semantic');

describe('semantic benchmark', () => {
    const cases = loadCases(ROOT);

    it('has cases for every built-in rule, including negatives', () => {
        const rules = new Set(cases.map(c => c.rule));
        expect(rules).toEqual(new Set([
            'in-memory-aggregation', 'credential-redirect', 'degraded-response-cached',
            ...[...ECOSYSTEM_RULES, ...CANDIDATE_RULES].map(rule => rule.id), null,
        ]));
    });

    for (const bench of cases) {
        it(`${bench.name}: ${bench.note}`, () => {
            const result = runCase(ROOT, bench);
            expect(result.falsePositives).toEqual([]);
            expect(result.caught).toBe(true);
        });
    }
});
