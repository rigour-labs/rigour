#!/usr/bin/env node
/**
 * Whether a new version of the embedding library gives the same vectors as the old one, so indexes built by one can be
 * searched with the other. Embeds a fixed sample of lines from this repository with each install (the same model,
 * mean pooling, normalised, 8-bit weights) and prints the cosine between the two vectors of every line.
 *
 * The rule (CONTRIBUTING.md, "Upgrading the embedding library"): min cosine >= 0.99 keeps the index version; below it,
 * bump the index version so every index is rebuilt on first use. Run by .github/workflows/embedding-parity.yml, which
 * installs both versions.
 *
 * Each library embeds in a process of its own, as in Rigour, where a process only ever loads one ONNX runtime. A child
 * that fails, or does not exit cleanly, fails the run.
 *
 *   node scripts/eval/embedding-parity.mjs <old-install-dir> <new-install-dir> [sample-size]
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

if (process.argv[2] === '--embed') await embedLines(process.argv[3]);
else compare(...process.argv.slice(2));

/** The child: embeds the lines on stdin with the library installed in `dir`, and prints its label and the vectors. */
async function embedLines(dir) {
    const lines = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { label, embed } = await embedder(dir);
    const vectors = [];
    for (const line of lines) vectors.push(await embed(line));
    process.stdout.write(JSON.stringify({ label, vectors }));
}

function compare(oldDir, newDir, size = '200') {
    if (!oldDir || !newDir) {
        console.error('usage: embedding-parity.mjs <old-install-dir> <new-install-dir> [sample-size]');
        process.exit(2);
    }
    const lines = sample(Number(size));
    const before = embedIn(oldDir, lines);
    const after = embedIn(newDir, lines);
    const scores = lines.map((line, index) => {
        const [a, b] = [before.vectors[index], after.vectors[index]];
        if (a.length !== b.length) {
            console.error(`dimension differs: ${before.label} ${a.length}, ${after.label} ${b.length}`);
            process.exit(1);
        }
        return { line, score: cosine(a, b), dim: a.length };
    }).sort((x, y) => x.score - y.score);
    const mean = scores.reduce((s, x) => s + x.score, 0) / scores.length;
    console.log(`${before.label} -> ${after.label}, ${MODEL}, ${scores.length} lines, dimension ${scores[0].dim}`);
    console.log(`cosine: min ${scores[0].score.toFixed(5)}, mean ${mean.toFixed(5)}`);
    console.log('5 lowest:');
    for (const { line, score } of scores.slice(0, 5)) console.log(`  ${score.toFixed(5)}  ${line}`);
    console.log(scores[0].score >= 0.99
        ? 'min >= 0.99: indexes built by either version can be searched by the other; keep the index version.'
        : 'min < 0.99: bump the index version so existing indexes rebuild on first use.');
}

/** Every Nth line of the tracked TypeScript sources: fixed for a commit, and text like what Rigour embeds. */
function sample(count) {
    const files = execFileSync('git', ['ls-files', 'packages/*/src/*.ts', 'packages/*/src/**/*.ts'], { encoding: 'utf8' })
        .split('\n').filter(f => f && !f.endsWith('.test.ts')).sort();
    const lines = new Set();
    for (const file of files) {
        for (const raw of execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')) {
            const line = raw.trim();
            if (line.length >= 30 && line.length <= 160 && /[a-z]{3}/i.test(line)) lines.add(line);
        }
    }
    const all = [...lines];
    const step = all.length / count;
    return Array.from({ length: Math.min(count, all.length) }, (_, i) => all[Math.floor(i * step)]);
}

/** One library's vectors for the lines, from a process of its own. */
function embedIn(dir, lines) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--embed', dir], { input: JSON.stringify(lines), encoding: 'utf8', maxBuffer: 256 << 20 });
    if (child.status !== 0) {
        console.error(`embedding with the library in ${dir} exited ${child.status ?? child.signal}:\n${child.stderr}`);
        process.exit(1);
    }
    return JSON.parse(child.stdout);
}

/** The library installed in `dir`, loaded the way Rigour loads it (semantic-runtime.ts), with its 8-bit model. */
async function embedder(dir) {
    const require = createRequire(path.join(path.resolve(dir), 'package.json'));
    for (const name of ['@huggingface/transformers', '@xenova/transformers']) {
        let entry;
        try { entry = require.resolve(name); } catch { continue; }
        // Read from disk: version 3 on does not export its package.json.
        const version = JSON.parse(fs.readFileSync(path.join(path.resolve(dir), 'node_modules', name, 'package.json'), 'utf8')).version;
        const lib = await import(pathToFileURL(entry).href);
        // Version 2 loads 8-bit weights by default (`quantized: true`); version 3 on asks for them by `dtype`.
        const options = name === '@xenova/transformers' ? { quantized: true } : { dtype: 'q8' };
        const extract = await lib.pipeline('feature-extraction', MODEL, options);
        return { label: `${name}@${version}`, embed: async text => Array.from((await extract(text, { pooling: 'mean', normalize: true })).data) };
    }
    throw new Error(`no transformers library installed in ${dir}`);
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / Math.sqrt(na * nb);
}
