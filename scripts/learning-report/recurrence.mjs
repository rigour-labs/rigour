#!/usr/bin/env node
// Cross-pull-request recurrence over the learner's default window (`learn-reviews --limit 100`): per repository, the
// 100 most recent pull requests merged before CUTOFF, read from the GitHub API only (no clone). Candidates are built
// by Rigour's own functions from each comment's text and path; with no checkout, a comment's identifiers come from its
// own text, not from the code lines it points at. Counts:
// - recurrence under the current rule: lessons mergeLessons joins across two or more pull requests, and how many of
//   those it verifies;
// - recurrence under a looser rule: candidate pairs on different pull requests by the same person (not a bot) that
//   share an identifier, whatever their files.
// Measures only. Writes results/recurrence-100.json: counts, lesson ids and source URLs, never comment text.
// Usage: npm run build first, then: node scripts/learning-report/recurrence.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CUTOFF, REPOS, github, isBot, sourceOf, sourceUrl } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW = 100;
const { lessonFromComment, lessonsFromReview, mergeLessons } = await import(path.join(here, '../../packages/rigour-core/dist/review-learning/lessons.js'));
/** No checkout: every git read fails, and the learner falls back to the comment's own text. */
const noGit = () => { throw new Error('no checkout'); };
const source = user => (isBot(user) || /bot$/i.test(String(user?.login ?? '')) ? 'bot' : 'person');

async function all(url) {
    const items = [];
    for (let page = 1; page <= 10; page++) {
        const batch = await github(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        items.push(...batch);
        if (batch.length < 100) break;
    }
    return items;
}

const out = { window: WINDOW, cutoff: CUTOFF, repos: {} };
for (const repo of REPOS) {
    const prs = [];
    for (let page = 1; prs.length < WINDOW && page <= 20; page++) {
        for (const pr of await github(`/repos/${repo}/pulls?state=closed&sort=created&direction=desc&per_page=100&page=${page}`)) {
            if (prs.length < WINDOW && pr.merged_at && pr.merged_at < CUTOFF) prs.push(pr);
        }
    }
    const candidates = [];
    for (const pr of prs) {
        const author = String(pr.user?.login ?? '');
        const [comments, reviews] = await Promise.all([all(`/repos/${repo}/pulls/${pr.number}/comments`), all(`/repos/${repo}/pulls/${pr.number}/reviews`)]);
        for (const c of comments) {
            const end = c.original_line ?? c.line;
            const commit = c.original_commit_id ?? c.commit_id;
            if (!c.user?.login || c.user.login === author || !c.path || !end || !commit || c.in_reply_to_id) continue;
            const start = c.original_start_line ?? c.start_line ?? end;
            const lesson = lessonFromComment(noGit, { id: String(c.id), prNumber: pr.number, path: c.path, start: Math.min(start, end), end, commit, body: String(c.body ?? ''), author: c.user.login, source: source(c.user), prAuthor: author });
            if (lesson) candidates.push(lesson);
        }
        for (const r of reviews) {
            if (!r.user?.login || r.user.login === author || !r.commit_id || !String(r.body ?? '').trim()) continue;
            candidates.push(...lessonsFromReview({ id: String(r.id), prNumber: pr.number, commit: r.commit_id, body: String(r.body), author: r.user.login, source: source(r.user), prAuthor: author }, []));
        }
    }
    const merged = mergeLessons([], candidates).lessons;
    const points = l => l.evidence.filter(e => (e.kind ?? 'point') === 'point');
    const recurring = merged.filter(l => new Set(points(l).map(e => e.pr)).size >= 2);
    const urlOf = l => sourceUrl(repo, points(l)[0].pr, sourceOf(points(l)[0].comment));

    // Looser: the same person, a shared identifier, different pull requests, any file.
    const people = merged.filter(l => points(l).some(e => e.source !== 'bot') && l.symbols.length);
    const loose = [];
    for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
        const [a, b] = [people[i], people[j]];
        const aPrs = new Set(points(a).map(e => e.pr));
        if (points(b).some(e => aPrs.has(e.pr))) continue;
        const aBy = new Set(points(a).filter(e => e.source !== 'bot').map(e => e.author));
        if (!points(b).some(e => e.source !== 'bot' && aBy.has(e.author))) continue;
        const shared = a.symbols.filter(s => b.symbols.includes(s));
        if (shared.length) loose.push({ a: urlOf(a), b: urlOf(b), shared: shared.slice(0, 3) });
    }
    out.repos[repo] = {
        prs: prs.length, candidates: candidates.length, lessons: merged.length,
        withIdentifiers: merged.filter(l => l.symbols.length).length,
        currentRule: { recurring: recurring.length, verified: merged.filter(l => l.state === 'verified').length, examples: recurring.slice(0, 5).map(urlOf) },
        looserRule: { pairs: loose.length, lessons: new Set(loose.flatMap(p => [p.a, p.b])).size, examples: loose.slice(0, 5) },
    };
    console.log(`${repo}: ${prs.length} PRs, ${merged.length} lessons; current rule ${recurring.length} recurring, ${out.repos[repo].currentRule.verified} verified; looser rule ${loose.length} pairs`);
}
fs.writeFileSync(path.join(here, 'results', 'recurrence-100.json'), JSON.stringify(out, null, 2) + '\n');
