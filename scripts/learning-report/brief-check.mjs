#!/usr/bin/env node
// What a learned lesson looks like when Phase 1's brief serves it: for a run's lessons store (kept in TEXT_CACHE by
// run.mjs), the real `rigour brief --files <file> --json` on each repository's FILES files with the most servable
// candidates (raised by a person),
// serving candidates too (gates.deep.review_lessons: all, since public stores have no verified lessons yet). Counts
// per file: items served (at most 3 expected), items cited, items that look broken (looksBroken). Writes the counts
// to results/<label>.brief.json; the briefs themselves quote review comments, so they stay in TEXT_CACHE (briefs/<label>.json,
// and brief-check/<repo>.txt: every served item, one per line, to read by eye).
// Usage: npm run build first, then: node scripts/learning-report/brief-check.mjs <label>
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { REPOS, TEXT_CACHE, looksBroken, setPath } from './common.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [label] = process.argv.slice(2);
if (!label) throw new Error('usage: brief-check.mjs <label>');
const CLI = process.env.LEARNING_REPORT_CLI || path.join(here, '../../packages/rigour-cli/dist/cli.js');
const FILES = 5;
const PER_FILE = 3;
const out = { label, at: new Date().toISOString(), repos: {} };
const briefs = {};

for (const repo of REPOS) {
    const storeFile = path.join(TEXT_CACHE, 'stores', label, `${repo.replace('/', '__')}.json`);
    if (!fs.existsSync(storeFile)) { console.log(`${repo}: no store for ${label}; run run.mjs ${label} first`); continue; }
    const lessons = JSON.parse(fs.readFileSync(storeFile, 'utf8')).lessons ?? [];
    // Files with the most candidates the brief can serve: a lesson only bots raised is never served (#163).
    const servable = l => l.file && l.state !== 'rejected' && l.evidence.some(e => (e.kind ?? 'point') === 'point' && e.source !== 'bot');
    const byFile = new Map();
    for (const l of lessons) if (servable(l)) byFile.set(l.file, (byFile.get(l.file) ?? 0) + 1);
    const files = [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, FILES).map(([f]) => f);
    // A throwaway checkout serving candidates, with the run's store and empty files at those paths.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-check-'));
    try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
        for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), ''); }
        fs.writeFileSync(path.join(dir, 'rigour.yml'), 'version: 1\ngates:\n  deep:\n    review_lessons: all\n');
        fs.mkdirSync(path.join(dir, '.rigour'));
        fs.copyFileSync(storeFile, path.join(dir, '.rigour', 'review-lessons.json'));
        execFileSync('git', ['add', '-A'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=check@example.com', '-c', 'user.name=check', 'commit', '-qm', 'fixture'], { cwd: dir });
        const perFile = [];
        briefs[repo] = {};
        for (const f of files) {
            const brief = JSON.parse(execFileSync(process.execPath, [CLI, 'brief', '--files', f, '--json', 'change this file'], { cwd: dir, encoding: 'utf8', env: { ...process.env, RIGOUR_REVIEW_LESSONS: '' } }));
            const lessonItems = brief.items.filter(i => i.kind === 'lesson');
            const onFile = lessonItems.filter(i => i.text.startsWith(`${f}: `));
            perFile.push({
                candidates: byFile.get(f), served: onFile.length, otherLessons: lessonItems.length - onFile.length,
                cited: lessonItems.filter(i => /PR #\d+/.test(i.cite ?? '')).length,
                broken: lessonItems.filter(i => looksBroken(i.text.replace(/^[^:]*:\s*/, ''))).length,
            });
            briefs[repo][f] = brief.items;
        }
        out.repos[repo] = {
            files: perFile.length,
            servedPerFile: perFile.map(p => p.served),
            overCap: perFile.filter(p => p.served > PER_FILE).length,
            lessonItems: perFile.reduce((n, p) => n + p.served + p.otherLessons, 0),
            uncited: perFile.reduce((n, p) => n + (p.served + p.otherLessons - p.cited), 0),
            broken: perFile.reduce((n, p) => n + p.broken, 0),
        };
        console.log(`${repo}: ${JSON.stringify(out.repos[repo])}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
fs.writeFileSync(setPath('results', `${label}.brief.json`), JSON.stringify(out, null, 2) + '\n');
fs.mkdirSync(path.join(TEXT_CACHE, 'briefs'), { recursive: true });
fs.writeFileSync(path.join(TEXT_CACHE, 'briefs', `${label}.json`), JSON.stringify(briefs, null, 2) + '\n');
// For reading by eye: every served item, one per line, with the file briefed, its kind and its citation.
fs.mkdirSync(path.join(TEXT_CACHE, 'brief-check'), { recursive: true });
for (const [repo, byBriefed] of Object.entries(briefs)) {
    const lines = [`# ${label}: rigour brief --files <file>, every item served (file briefed, kind, citation, text)`];
    for (const [f, items] of Object.entries(byBriefed)) for (const i of items) lines.push([f, i.kind, i.cite ?? '', String(i.text).replace(/\s+/g, ' ')].join('\t'));
    fs.writeFileSync(path.join(TEXT_CACHE, 'brief-check', `${repo.replace('/', '__')}.txt`), lines.join('\n') + '\n');
}
