#!/usr/bin/env node
// Pins the pull requests the learning-quality report reads, once, by a rule fixed before any result: per repository,
// the PR_COUNT most recent pull requests (by creation) merged before CUTOFF that have at least one review comment or
// non-empty review body from a person (not a bot) other than the author. Written to prs.json and committed, so every
// later run reads the same input.
// Usage: node scripts/learning-report/select.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { REPOS, CUTOFF, PR_COUNT, github, isBot } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// A repository already pinned keeps its pins: the input never moves under a run.
const file = path.join(here, 'prs.json');
const out = fs.existsSync(file) ? Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).prs).filter(([repo]) => REPOS.includes(repo))) : {};
for (const repo of REPOS.filter(r => !out[r])) {
    const count = PR_COUNT[repo];
    const picked = [];
    for (let page = 1; picked.length < count && page <= 30; page++) {
        const batch = await github(`/repos/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=50&page=${page}`);
        if (batch.length === 0) break;
        for (const pr of batch) {
            if (picked.length >= count) break;
            if (!pr.merged_at || pr.merged_at >= CUTOFF) continue;
            const author = pr.user?.login;
            const [comments, reviews] = await Promise.all([
                github(`/repos/${repo}/pulls/${pr.number}/comments?per_page=100`),
                github(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`),
            ]);
            const person = user => user?.login && user.login !== author && !isBot(user);
            const byOthers = comments.some(c => person(c.user)) || reviews.some(r => person(r.user) && String(r.body ?? '').trim());
            if (byOthers) picked.push(pr.number);
        }
    }
    out[repo] = picked.sort((a, b) => a - b);
    console.log(`${repo}: ${picked.length} pull requests`);
}
const rule = 'the most recent pull requests (by creation) merged before the cutoff with at least one review comment or non-empty review body from a person (not a bot) other than the author';
fs.writeFileSync(file, JSON.stringify({ cutoff: CUTOFF, rule, counts: PR_COUNT, prs: out }, null, 2) + '\n');
