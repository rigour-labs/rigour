#!/usr/bin/env node
/**
 * What semantic search is worth: recall's two real modes, local embeddings and the keyword
 * fallback Rigour uses when the embedding library is not installed, on the committed eval sets
 * (memory-recall.json, pattern-intent.json). Recall: queries with a right answer that got one.
 * Noise: unrelated queries that got anything.
 *
 *   pnpm build && node scripts/eval/semantic-vs-keyword.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const core = path.join(here, '../../packages/rigour-core/dist');
const { rankByMeaning, memoryText } = await import(`${core}/memory/recall.js`);
const { generateEmbedding, patternEmbeddingText } = await import(`${core}/pattern-index/embeddings.js`);
const read = name => JSON.parse(fs.readFileSync(path.join(here, name), 'utf8'));

const memory = read('memory-recall.json');
const pattern = read('pattern-intent.json');
const sets = {
    memory: { items: Object.entries(memory.memories).map(([key, value]) => ({ id: key, text: memoryText({ key, value }) })), queries: memory.queries },
    pattern: { items: pattern.patterns.map(p => ({ id: p.name, text: patternEmbeddingText(p) })), queries: pattern.queries },
};
if ((await generateEmbedding('probe')).length === 0) throw new Error('The embedding library is not installed; run pnpm install (or rigour setup) first.');

const keywordsOnly = async () => [];
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-').padStart(4);
console.log('set      mode      recall        noise');
for (const [name, { items, queries }] of Object.entries(sets)) {
    for (const [mode, embed] of [['semantic', generateEmbedding], ['keyword', keywordsOnly]]) {
        let wanted = 0, found = 0, unrelated = 0, noisy = 0;
        for (const { q, expect } of queries) {
            const hits = (await rankByMeaning(q, items, item => item.text, embed)).map(hit => hit.id);
            if (expect.length) { wanted++; if (hits.some(hit => expect.includes(hit))) found++; }
            else { unrelated++; if (hits.length) noisy++; }
        }
        console.log(`${name.padEnd(8)} ${mode.padEnd(9)} ${pct(found, wanted)} (${found}/${wanted})   ${pct(noisy, unrelated)} (${noisy}/${unrelated})`);
    }
}
