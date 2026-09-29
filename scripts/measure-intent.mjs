#!/usr/bin/env node
/**
 * Measures the local model on the labelled intent set (benchmarks/intent).
 *
 *   node scripts/measure-intent.mjs [--tiers lite,deep] [--runs 2]
 *
 * Reports, per tier and run: raw answer accuracy, how many reads survive the
 * flipped-question filter and how many of those are right, and site-level
 * findings (true positives, misses, false positives). Local only: the model
 * runs through the llama.cpp sidecar; nothing leaves the machine.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (file) => import(path.join(repo, 'packages/rigour-core/dist', file));
const { SidecarProvider } = await dist('inference/index.js');
const { loadIntentCases, runIntentCase, scoreIntent } = await dist('semantic/intent/benchmark.js');
const { yesNoModel } = await dist('semantic/intent/intent-check.js');
const root = path.join(repo, 'benchmarks', 'intent');
const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index > 0 ? process.argv[index + 1] : fallback;
};
const tiers = arg('tiers', 'lite,deep').split(',');
const runs = Number(arg('runs', '2'));
const cases = loadIntentCases(root);
const pct = (n, d) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);

for (const tier of tiers) {
    const provider = new SidecarProvider(tier);
    await provider.setup((message) => process.stderr.write(`  ${message}\n`));
    const model = yesNoModel(provider);
    for (let run = 1; run <= runs; run += 1) {
        const started = Date.now();
        const results = [];
        for (const bench of cases) results.push(await runIntentCase(root, bench, model));
        const s = scoreIntent(results);
        console.log(`${tier} run ${run} (${provider.getActiveModel()?.name}), ${((Date.now() - started) / 1000).toFixed(0)}s`);
        console.log(`  raw answers correct: ${s.rawCorrect}/${s.rawTotal} (${pct(s.rawCorrect, s.rawTotal)})`);
        console.log(`  reads kept by the filter: ${s.consistent}/${s.reads} (discarded ${pct(s.reads - s.consistent, s.reads)}); kept and correct: ${s.consistentCorrect}/${s.consistent} (${pct(s.consistentCorrect, s.consistent)})`);
        console.log(`  sites: ${s.truePositives} caught, ${s.falseNegatives} missed, ${s.falsePositives} false findings; finder errors: ${s.finderErrors.join(', ') || 'none'}`);
        for (const result of results) {
            const detail = result.verdicts.map(v => `${v.read.label}=${v.verdict}(${v.answers.join('/')})`).join(' ');
            console.log(`    ${result.case.name}: ${result.findings} finding(s) ${detail}`);
        }
    }
    provider.dispose();
}
