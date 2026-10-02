#!/usr/bin/env node
/**
 * Measure reinvention detection by intent: an agent describes what it is about to write, and the
 * pattern index should name the existing function that already does it. Compares the text a
 * pattern is embedded by (its raw name vs the name split into words) across thresholds.
 * The dataset is scripts/eval/pattern-intent.json.
 *
 *   pnpm build && node scripts/eval/pattern-intent.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { generateEmbedding, cosineSimilarity } = await import(path.join(here, '../../packages/rigour-core/dist/pattern-index/embeddings.js'));
const data = JSON.parse(fs.readFileSync(path.join(here, 'pattern-intent.json'), 'utf8'));
const words = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
const variants = {
    raw: p => `${p.name} ${p.type} ${p.description}`,
    words: p => `${words(p.name)} ${p.type} ${p.description}`,
};

for (const [variant, text] of Object.entries(variants)) {
    const patterns = await Promise.all(data.patterns.map(async p => ({ name: p.name, vector: await generateEmbedding(text(p)) })));
    const scored = await Promise.all(data.queries.map(async ({ q, expect }) => {
        const v = await generateEmbedding(q);
        return { expect, ranked: patterns.map(p => ({ name: p.name, score: cosineSimilarity(v, p.vector) })).sort((a, b) => b.score - a.score) };
    }));
    console.log(`\n${variant}: threshold  top-1 right  recall  noise`);
    for (const threshold of [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6]) {
        let wanted = 0, found = 0, top = 0, returned = 0, unrelated = 0, noisy = 0;
        for (const { expect, ranked } of scored) {
            const best = ranked[0].score >= threshold ? ranked[0].name : undefined;
            if (best) { returned++; if (expect.includes(best)) top++; }
            if (expect.length) { wanted++; if (best && expect.includes(best)) found++; } else { unrelated++; if (best) noisy++; }
        }
        const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-').padStart(5);
        console.log(`${' '.repeat(variant.length)}  ${threshold.toFixed(2)}       ${pct(top, returned)}     ${pct(found, wanted)}  ${pct(noisy, unrelated)}`);
    }
}
