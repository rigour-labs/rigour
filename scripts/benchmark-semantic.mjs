#!/usr/bin/env node
/**
 * Semantic benchmark report: recall on `before/`, false positives on
 * `after/` and negative cases. Requires `pnpm build` first.
 *
 *   pnpm benchmark:semantic
 */
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadCases, runCase } = await import(path.join(root, 'packages/rigour-core/dist/semantic/benchmark.js'));

const casesDir = path.join(root, 'benchmarks/semantic');
const results = loadCases(casesDir).map(bench => runCase(casesDir, bench));
const positives = results.filter(r => r.case.rule !== null);
const caught = positives.filter(r => r.caught).length;
const falsePositives = results.flatMap(r => r.falsePositives.map(fp => `${r.case.name}: ${fp}`));

for (const r of results) {
    const verdict = r.case.rule === null ? 'negative' : r.caught ? 'caught' : 'MISSED';
    console.log(`${verdict.padEnd(9)} ${r.case.name.padEnd(28)} ${r.falsePositives.length ? `FP: ${r.falsePositives.join('; ')}` : ''}`);
}
console.log(`\nRecall ${caught}/${positives.length}, false positives ${falsePositives.length} across ${results.length} cases.`);
process.exit(caught === positives.length && falsePositives.length === 0 ? 0 : 1);
