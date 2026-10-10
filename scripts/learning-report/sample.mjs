#!/usr/bin/env node
// Draws the precision sample ONCE, from the baseline run: SAMPLE candidates per repository with a fixed seed, and
// writes their source comments (the inline comment, or the review whose body the point is in) to labels/<repo>.json
// with its URL and an empty label; the comment's own text, for the labeller, goes to TEXT_CACHE, never the repository. A person labels each source once: "a" (it asks for
// something a person could act on) or "b" (it does not: praise, status, thanks). Labels are never redone: later runs
// join them by source id. Refuses to overwrite a labels file.
// Usage: node scripts/learning-report/sample.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REPOS, TEXT_CACHE, github, sourceUrl } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = 40;
const SEED = 20261010;
const baseline = JSON.parse(fs.readFileSync(path.join(here, 'results', 'baseline.json'), 'utf8'));
const texts = JSON.parse(fs.readFileSync(path.join(TEXT_CACHE, 'baseline.json'), 'utf8'));

/** A small seeded generator (mulberry32), so the same candidates are drawn on any machine. */
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

for (const repo of REPOS) {
    const file = path.join(here, 'labels', `${repo.replace('/', '__')}.json`);
    if (fs.existsSync(file)) { console.log(`${repo}: labels exist, not redrawn`); continue; }
    const lessons = [...baseline.repos[repo].lessons].sort((a, b) => a.id.localeCompare(b.id));
    const next = random(SEED);
    for (let i = lessons.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [lessons[i], lessons[j]] = [lessons[j], lessons[i]]; }
    const drawn = lessons.slice(0, SAMPLE);
    const sources = {};
    const forLabeller = {};
    const textOf = new Map(texts[repo].map(l => [l.id, l.text]));
    for (const l of drawn) for (const source of l.sources) {
        if (sources[source]) continue;
        const pr = l.prs[0];
        const body = source.startsWith('review-')
            ? (await github(`/repos/${repo}/pulls/${pr}/reviews/${source.slice(7)}`)).body
            : (await github(`/repos/${repo}/pulls/comments/${source}`)).body;
        sources[source] = { pr, url: sourceUrl(repo, pr, source), label: null };
        forLabeller[source] = { body: String(body ?? ''), candidate: textOf.get(l.id) };
    }
    fs.writeFileSync(file, JSON.stringify({ repo, seed: SEED, sample: drawn.length, drawnFrom: 'baseline', rubric: 'judge the text, not its author: a = asks for something a person could act on, or names a concrete defect; b = does not (praise, status, thanks, a summary)', sources }, null, 2) + '\n');
    fs.mkdirSync(path.join(TEXT_CACHE, 'labels'), { recursive: true });
    fs.writeFileSync(path.join(TEXT_CACHE, 'labels', `${repo.replace('/', '__')}.json`), JSON.stringify(forLabeller, null, 2) + '\n');
    console.log(`${repo}: ${drawn.length} candidates, ${Object.keys(sources).length} source comments to label`);
}
