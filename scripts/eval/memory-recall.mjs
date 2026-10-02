#!/usr/bin/env node
/**
 * Measure memory recall by meaning: for each threshold, the share of returned memories that were
 * right (precision), the share of queries with a right memory that got it (recall), and how often
 * an unrelated query got anything (noise). The dataset is scripts/eval/memory-recall.json.
 *
 *   pnpm build && node scripts/eval/memory-recall.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '../../packages/rigour-core/dist');
const { generateEmbedding, cosineSimilarity } = await import(`${core}/pattern-index/embeddings.js`);
const { memoryText, RECALL_LIMIT } = await import(`${core}/memory/recall.js`);
const data = JSON.parse(fs.readFileSync(path.join(here, 'memory-recall.json'), 'utf8'));

const memories = await Promise.all(Object.entries(data.memories).map(async ([key, value]) => ({ key, vector: await generateEmbedding(memoryText({ key, value })) })));
if (memories[0].vector.length === 0) throw new Error('Embedding model unavailable; nothing to measure.');
const scored = await Promise.all(data.queries.map(async ({ q, expect }) => {
    const vector = await generateEmbedding(q);
    const ranked = memories.map(m => ({ key: m.key, score: cosineSimilarity(vector, m.vector) })).sort((a, b) => b.score - a.score);
    return { q, expect, ranked };
}));

console.log('threshold  precision  recall  noise   (returned top', RECALL_LIMIT + ')');
for (const threshold of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
    let returned = 0, right = 0, wanted = 0, found = 0, unrelated = 0, noisy = 0;
    for (const { expect, ranked } of scored) {
        const hits = ranked.filter(r => r.score >= threshold).slice(0, RECALL_LIMIT).map(r => r.key);
        returned += hits.length;
        right += hits.filter(k => expect.includes(k)).length;
        if (expect.length) { wanted++; if (hits.some(k => expect.includes(k))) found++; }
        else { unrelated++; if (hits.length) noisy++; }
    }
    const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-').padStart(6);
    console.log(`${threshold.toFixed(2).padStart(9)}  ${pct(right, returned)}     ${pct(found, wanted)}  ${pct(noisy, unrelated)}`);
}
if (process.argv.includes('--detail')) for (const { q, ranked } of scored) console.log(q.padEnd(58), ranked.slice(0, 2).map(r => `${r.key}=${r.score.toFixed(2)}`).join('  '));
