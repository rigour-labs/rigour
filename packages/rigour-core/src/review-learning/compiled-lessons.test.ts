import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { compiledLessonFailures, decideCompiledCheck, proposeCompiledChecks, readCompiledChecks, suspension } from './compiled-lessons.js';
import type { ReviewLesson } from './lessons.js';
import { execFileSync } from 'child_process';
import { appendTaskEvent } from '../task/thread.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'compiled-lessons-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

/** A lesson on `file` naming `symbols`, whose evidence is a point plus `kinds`. */
function lesson(id: string, text: string, symbols: string[], kinds: string[], file = 'src/load.ts'): ReviewLesson {
    return { id, text, file, symbols, state: 'candidate', createdAt: '', updatedAt: '',
        evidence: [{ kind: 'point', pr: 1, comment: `p-${id}`, author: 'r' }, ...kinds.map((kind, i) => ({ kind, pr: 1, comment: `${kind}-${id}-${i}`, author: 'p' }))] as ReviewLesson['evidence'] };
}
const lessons = (list: ReviewLesson[]) => {
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: list }));
};
const config = (block = false) => ConfigSchema.parse({ version: 1, gates: { compiled_lessons: { block } } });

describe('compiled lessons', () => {
    it('proposes a check only for a lesson a person confirmed or that recurred, and only when a template fits', () => {
        lessons([
            lesson('L1', 'Never call `fetchAll` in a request handler: it reads the whole table.', ['fetchAll'], ['accepted']),
            lesson('L2', 'Use `loadPage` instead of `fetchAll` here.', ['loadPage', 'fetchAll'], ['correction']),
            lesson('L3', 'Always wrap `preloadData` in `resolve` so the path is checked.', ['preloadData', 'resolve'], ['accepted']),
            lesson('L4', 'Never call `fetchAll` here.', ['fetchAll'], ['lines']), // an outcome only: never compiled
            lesson('L5', 'Think about `fetchAll` here.', ['fetchAll'], ['accepted']), // no template says what is wrong
        ]);
        const proposed = proposeCompiledChecks(cwd);
        expect(proposed.map(c => [c.lessonId, c.kind, c.symbol, c.with, c.state])).toEqual([
            ['L1', 'forbid', 'fetchAll', undefined, 'proposed'],
            ['L2', 'forbid', 'fetchAll', undefined, 'proposed'],
            ['L3', 'require', 'preloadData', 'resolve', 'proposed'],
        ]);
        expect(proposeCompiledChecks(cwd)).toEqual([]); // proposed once
    });

    it('runs only once a person approved it, as a note unless the team blocks, and stops when taken back', () => {
        lessons([lesson('L1', 'Never call `fetchAll` in a request handler.', ['fetchAll'], ['accepted']), lesson('L3', 'Always wrap `preloadData` in `resolve`.', ['preloadData', 'resolve'], ['accepted'])]);
        proposeCompiledChecks(cwd);
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src/load.ts'), 'const rows = fetchAll(db);\nconst a = preloadData(x);\nconst b = resolve(preloadData(y));\n');
        const changed = { 'src/load.ts': new Set([1, 2, 3]) };
        expect(compiledLessonFailures(cwd, changed, config())).toEqual([]); // proposed: not running
        decideCompiledCheck(cwd, 'c-L1', 'active', 'ana@example.com');
        decideCompiledCheck(cwd, 'c-L3', 'active', 'ana@example.com');
        const notes = compiledLessonFailures(cwd, changed, config());
        // line 2 has preloadData with resolve within reach (line 3): paired; so only fetchAll on line 1
        expect(notes.map(f => [f.line, f.advisory, f.details.includes('lesson L1')])).toEqual([[1, true, true]]);
        expect(compiledLessonFailures(cwd, changed, config(true))[0]).not.toHaveProperty('advisory');
        decideCompiledCheck(cwd, 'c-L1', 'withdrawn', 'ana@example.com');
        expect(compiledLessonFailures(cwd, changed, config())).toEqual([]);
        expect(readCompiledChecks(cwd).find(c => c.id === 'c-L1')).toMatchObject({ state: 'withdrawn', by: 'ana@example.com', lessonId: 'L1' });
    });

    it('reports a required partner that is missing near the trigger', () => {
        lessons([lesson('L3', 'Always wrap `preloadData` in `resolve`.', ['preloadData', 'resolve'], ['accepted'])]);
        proposeCompiledChecks(cwd);
        decideCompiledCheck(cwd, 'c-L3', 'active', 'ana@example.com');
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src/load.ts'), 'const a = preloadData(x);\n\n\n\n\n\nconst b = resolve(y);\n');
        expect(compiledLessonFailures(cwd, { 'src/load.ts': new Set([1]) }, config()).map(f => f.title)).toEqual(['`preloadData` without `resolve`: the team\'s lesson says to pair them']);
    });

    it('backtests a proposal over the main branch: fires where a review found the lesson repeating, and counts every other fire', () => {
        const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        const commit = (body: string, subject: string) => {
            fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
            fs.writeFileSync(path.join(cwd, 'src/load.ts'), body);
            git('add', 'src/load.ts');
            git('commit', '-qm', subject);
        };
        commit('export const a = 1;\n', 'init');
        commit('export const a = 1;\nconst rows = fetchAll(db);\n', 'load every row (#1)');
        commit('export const a = 1;\nconst rows = loadPage(db);\n', 'page it (#2)');
        commit('export const a = 1;\nconst rows = loadPage(db);\nconst all = fetchAll(db);\n', 'export all (#3)');
        appendTaskEvent(cwd, { kind: 'review', pr: 1, outcome: 'findings', lessons_applied: ['L1'] });
        lessons([lesson('L1', 'Never call `fetchAll` in a request handler.', ['fetchAll'], ['accepted'])]);
        const [proposed] = proposeCompiledChecks(cwd);
        expect(readCompiledChecks(cwd).find(c => c.id === proposed.id)?.backtest).toMatchObject({ repeating: { fired: 1, n: 1, rate: null }, other: { fired: 1, n: 2, rate: null }, commits: 3 }); // a rate only from ten
    });

    it('compiles no lesson a reclassification sent back to candidate, no legacy one, and never inverts "never forget"', () => {
        lessons([
            lesson('R1', 'Never call `fetchAll` here.', ['fetchAll'], ['lines', 'reclassified']),
            { ...lesson('G1', 'Never call `fetchAll` here.', ['fetchAll'], []), state: 'verified', evidence: [{ pr: 1, comment: 'old', author: 'r' }] } as ReviewLesson, // legacy: no evidence kinds
            lesson('F1', 'Never forget to call `flush` before returning.', ['flush'], ['accepted']),
            lesson('F2', "Don't skip `validate` on input.", ['validate'], ['accepted']),
        ]);
        expect(proposeCompiledChecks(cwd)).toEqual([]);
    });

    it('keeps every decision, on the check and on its lesson', () => {
        lessons([lesson('L1', 'Never call `fetchAll` here.', ['fetchAll'], ['accepted'])]);
        proposeCompiledChecks(cwd);
        decideCompiledCheck(cwd, 'c-L1', 'active', 'ana@example.com');
        decideCompiledCheck(cwd, 'c-L1', 'withdrawn', 'bo@example.com');
        expect(readCompiledChecks(cwd)[0].history?.map(h => [h.state, h.by])).toEqual([['active', 'ana@example.com'], ['withdrawn', 'bo@example.com']]);
        const trail = JSON.parse(fs.readFileSync(path.join(cwd, '.rigour', 'review-lessons.json'), 'utf8')).lessons[0].evidence.filter((e: { kind: string }) => e.kind === 'compiled');
        expect(trail.map((e: { author: string; detail: string }) => [e.author, e.detail])).toEqual([['ana@example.com', 'approved compiled check c-L1'], ['bo@example.com', 'took back compiled check c-L1']]);
    });

    it('suspends an approved check whose lesson a person later rejected, and refuses to approve one', () => {
        lessons([lesson('L1', 'Never call `fetchAll` here.', ['fetchAll'], ['accepted'])]);
        proposeCompiledChecks(cwd);
        decideCompiledCheck(cwd, 'c-L1', 'active', 'ana@example.com');
        fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'src/load.ts'), 'const rows = fetchAll(db);\n');
        expect(compiledLessonFailures(cwd, { 'src/load.ts': new Set([1]) }, config())).toHaveLength(1);
        const file = path.join(cwd, '.rigour', 'review-lessons.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        data.lessons[0].evidence.push({ kind: 'rejected', pr: 1, comment: 'r', author: 'bo@example.com' });
        fs.writeFileSync(file, JSON.stringify(data));
        expect(compiledLessonFailures(cwd, { 'src/load.ts': new Set([1]) }, config())).toEqual([]);
        const check = readCompiledChecks(cwd)[0];
        expect(suspension(check, new Map([[data.lessons[0].id, data.lessons[0]]]))).toContain('no longer qualifies (rejected)');
        decideCompiledCheck(cwd, 'c-L1', 'withdrawn', 'bo@example.com');
        expect(() => decideCompiledCheck(cwd, 'c-L1', 'active', 'ana@example.com')).toThrow('no longer qualifies');
    });
});
