#!/usr/bin/env node
// Runs Rigour's learning on the pinned pull requests (prs.json) of each public repository and records what it
// made: raw points, candidates, verified lessons, by people and bots. One run per label (`baseline`, `b1`, …).
// Each repository gets a blobless clone (every commit and tree; file contents fetched when read), measured, stopped
// past CLONE_CAP_BYTES, and deleted as soon as its repository is done. $0: GitHub reads and git fetches only, no model.
// Candidate texts go to TEXT_CACHE, outside the repository; results/ holds ids, hashes and counts only.
// Usage: npm run build first, then: node scripts/learning-report/run.mjs <label> <scratch dir> [repo …]
// Naming repositories re-runs only those, into the same results file (the others are kept).
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLONE_CAP_BYTES, CLONE_FILTER, REPOS, TEXT_CACHE, creditUnits, githubToken, looksBroken, nearDuplicates, sourceOf, sourceUrl, textHash } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [label, scratch, ...only] = process.argv.slice(2);
if (!label || !scratch) throw new Error('usage: run.mjs <label> <scratch dir>');
const { learnFromReviews, readLessons } = await import(path.join(here, '../../packages/rigour-core/dist/index.js'));
const { prs } = JSON.parse(fs.readFileSync(path.join(here, 'prs.json'), 'utf8'));
const kb = dir => Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]);

/** The labeller's unit cache for a repository (review bodies split into labelled units), if present. */
const unitCache = repo => {
    const file = path.join(TEXT_CACHE, 'labels', `${repo.replace('/', '__')}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
};
const count = keys => keys.reduce((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
const pointsOf = l => l.evidence.filter(e => (e.kind ?? 'point') === 'point');

/** Mirrors lessonState's checks, in its order, to name the first one a candidate fails. */
function whyCandidate(l) {
    const kinds = new Set(l.evidence.map(e => e.kind));
    if (kinds.has('norule')) return 'judged no rule';
    if (kinds.has('demoted')) return 'taken back by evidence';
    if (kinds.has('counter')) return 'held back by counter-evidence';
    const points = pointsOf(l);
    if (points.every(e => e.source === 'bot')) return 'raised only by bots';
    if (new Set(points.map(e => e.pr)).size < 2) return 'raised on one pull request only';
    if (new Set(points.map(e => e.prAuthor).filter(Boolean)).size < 2) return 'one pull request author only';
    return 'one reviewer, one wording';
}

const resultFile = path.join(here, 'results', `${label}.json`);
const cacheFile = path.join(TEXT_CACHE, `${label}.json`);
const cached = only.length && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const result = only.length && fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { label, at: new Date().toISOString(), repos: {} };

/** A transient network failure (a dropped connection, not an HTTP status) is retried a few times. */
async function withRetry(read) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await read();
        } catch (error) {
            if (attempt >= 4 || !/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(String(error?.message ?? error))) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

for (const repo of only.length ? only : REPOS) {
    const clone = path.join(scratch, repo.replace('/', '__'));
    fs.rmSync(clone, { recursive: true, force: true });
    const started = Date.now();
    execFileSync('git', ['clone', '-q', `--filter=${CLONE_FILTER}`, '--no-checkout', `https://github.com/${repo}.git`, clone], { stdio: 'inherit' });
    const store = path.join(scratch, `${repo.replace('/', '__')}.lessons.json`);
    fs.rmSync(store, { force: true });
    process.env.RIGOUR_REVIEW_LESSONS = store;
    let comments = 0, bodies = 0, maxKb = kb(clone);
    try {
        for (const pr of prs[repo]) {
            const r = await withRetry(() => learnFromReviews(clone, { token: githubToken(), repo, pr }));
            comments += r.comments;
            bodies += r.reviewBodies;
            maxKb = Math.max(maxKb, kb(clone));
            if (maxKb * 1024 > CLONE_CAP_BYTES) throw new Error(`${repo}: the clone passed ${CLONE_CAP_BYTES / 1024 ** 3} GB (${Math.round(maxKb / 1024)} MB, --filter=${CLONE_FILTER}); stopped`);
        }
        const lessons = readLessons(clone);
        const points = lessons.flatMap(l => l.evidence.filter(e => (e.kind ?? 'point') === 'point').map(e => ({ ...e, lesson: l.id })));
        result.repos[repo] = {
            prs: prs[repo].length, inlineComments: comments, reviewBodies: bodies,
            points: { total: points.length, people: points.filter(e => e.source !== 'bot').length, bots: points.filter(e => e.source === 'bot').length },
            candidates: lessons.length,
            verified: lessons.filter(l => l.state === 'verified').length,
            verifiedBy: Object.fromEntries(['recurrence', 'person', 'correction', 'outcome', 'legacy'].map(k => [k, lessons.filter(l => l.state === 'verified' && l.promotedBy === k).length])),
            cloneMode: `--filter=${CLONE_FILTER}`, cloneMb: Math.round(maxKb / 1024), seconds: Math.round((Date.now() - started) / 1000),
            // Why each candidate is not verified: the first condition of lessonState it fails, in lessonState's order.
            notVerified: count(lessons.filter(l => l.state === 'candidate').map(whyCandidate)),
            // Every candidate, by the source comments its points came from (labels join on these), with a hash of its
            // text and whether it looks broken; never the text itself, which stays in TEXT_CACHE.
            lessons: lessons.map(l => {
                const sources = [...new Set(pointsOf(l).map(e => sourceOf(e.comment)))];
                return { id: l.id, textHash: textHash(l.text), broken: looksBroken(l.text), file: l.file, state: l.state, sources, units: creditUnits(l.text, sources, unitCache(repo)), prs: [...new Set(l.evidence.map(e => e.pr))], bot: pointsOf(l).every(e => e.source === 'bot') };
            }),
            nearDuplicates: nearDuplicates(lessons.map(l => ({ id: l.id, text: l.text, prs: [...new Set(l.evidence.map(e => e.pr))] }))),
        };
        cached[repo] = lessons.map(l => ({ id: l.id, text: l.text, file: l.file, urls: [...new Set(pointsOf(l).map(e => sourceUrl(repo, e.pr, sourceOf(e.comment))))] }));
        console.log(`${repo}: ${result.repos[repo].points.total} points, ${result.repos[repo].candidates} candidates, ${result.repos[repo].verified} verified, clone ${result.repos[repo].cloneMb} MB, ${result.repos[repo].seconds}s`);
    } catch (error) {
        // A repository over the cap is recorded as stopped, with how far its clone got; the others still run.
        result.repos[repo] = { stopped: error.message, cloneMode: `--filter=${CLONE_FILTER}`, cloneMb: Math.round(maxKb / 1024) };
        console.log(error.message);
    } finally {
        fs.rmSync(clone, { recursive: true, force: true });
        fs.rmSync(store, { force: true });
    }
}
fs.writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
fs.mkdirSync(TEXT_CACHE, { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify(cached, null, 2) + '\n');
