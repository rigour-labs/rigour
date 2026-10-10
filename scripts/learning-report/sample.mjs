#!/usr/bin/env node
// Draws the precision sample ONCE, from the baseline run: SAMPLE candidates per repository with a fixed seed, and
// writes their source comments (the inline comment, or the review whose body the point is in) to labels/<repo>.json
// with its URL and an empty label; the comment's own text, for the labeller, goes to TEXT_CACHE, never the repository. A person labels each source once: "a" (it asks for
// something a person could act on) or "b" (it does not: praise, status, thanks). Labels are never redone: later runs
// join them by source id. Refuses to overwrite a labels file.
// Usage: node scripts/learning-report/sample.mjs
import fs from 'fs';
import path from 'path';
import { REPOS, SAMPLE, TEXT_CACHE, github, setPath, sourceUrl } from './common.mjs';

const SEED = 20261010;
const baseline = JSON.parse(fs.readFileSync(setPath('results', 'baseline.json'), 'utf8'));
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
    const file = setPath('labels', `${repo.replace('/', '__')}.json`);
    if (fs.existsSync(file)) { console.log(`${repo}: labels exist, not redrawn`); continue; }
    const lessons = [...baseline.repos[repo].lessons].sort((a, b) => a.id.localeCompare(b.id));
    const next = random(SEED);
    for (let i = lessons.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [lessons[i], lessons[j]] = [lessons[j], lessons[i]]; }
    // A number of candidates, or candidates in drawing order until a number of distinct source comments.
    const drawn = [];
    const seen = new Set();
    for (const l of lessons) {
        if (SAMPLE.candidates !== undefined ? drawn.length >= SAMPLE.candidates : seen.size >= SAMPLE.sources) break;
        drawn.push(l);
        l.sources.forEach(s => seen.add(s));
    }
    const sources = {};
    const forLabeller = {};
    const textOf = new Map(texts[repo].map(l => [l.id, l.text]));
    for (const l of drawn) for (const source of l.sources) {
        if (sources[source]) continue;
        // A candidate merged across pull requests lists them all: the source belongs to the one that has it.
        let pr, body;
        for (const candidatePr of l.prs) {
            try {
                body = source.startsWith('review-')
                    ? (await github(`/repos/${repo}/pulls/${candidatePr}/reviews/${source.slice(7)}`)).body
                    : (await github(`/repos/${repo}/pulls/comments/${source}`)).body;
                pr = candidatePr;
                break;
            } catch {
                // Not on this pull request; try the next.
            }
        }
        if (pr === undefined) throw new Error(`${repo}: source ${source} is on none of ${l.prs.join(', ')}`);
        sources[source] = { pr, url: sourceUrl(repo, pr, source), label: null };
        forLabeller[source] = { body: String(body ?? ''), candidate: textOf.get(l.id) };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ repo, seed: SEED, sample: drawn.length, drawnFrom: 'baseline', rubric: 'judge the text, not its author: a = asks for something a person could act on, or names a concrete defect; b = does not (praise, status, thanks, a summary)', sources }, null, 2) + '\n');
    fs.mkdirSync(path.join(TEXT_CACHE, 'labels'), { recursive: true });
    fs.writeFileSync(path.join(TEXT_CACHE, 'labels', `${repo.replace('/', '__')}.json`), JSON.stringify(forLabeller, null, 2) + '\n');
    console.log(`${repo}: ${drawn.length} candidates, ${Object.keys(sources).length} source comments to label`);
}
