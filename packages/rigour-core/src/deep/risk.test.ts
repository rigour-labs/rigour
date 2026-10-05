import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { functionHash, rankChangedFunctions, scoreRisk, type RiskSignals } from './risk.js';
import { DEFAULT_MIN_SCORE, routeFiles } from './router.js';
import type { ReviewLesson } from '../review-learning/lessons.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const SYNC = [
    'export async function syncOrders(db, cursor) {',      // 1
    '  for (const page of pages(cursor)) {',               // 2
    '    if (page.rows.length) {',                         // 3
    "      await db.from('orders').upsert(page.rows);",     // 4
    '    }',                                               // 5
    '  }',                                                 // 6
    '}',                                                   // 7
    'function label(name) {',                              // 8
    '  return name.trim();',                               // 9
    '}',                                                   // 10
].join('\n');

const plain: RiskSignals = { exported: false, async: false, nesting: 0, lines: 3, removedGuard: false, sensitive: [] };

describe('rankChangedFunctions', () => {
    it('reads the signals of each changed function', () => {
        fs.writeFileSync(path.join(dir, 'sync.ts'), SYNC);
        const ranked = rankChangedFunctions(dir, { 'sync.ts': [4, 9] }, { 'sync.ts': [{ line: 4, text: ['    if (!page.ok) return;'] }] });
        const byName = Object.fromEntries(ranked.map(f => [f.name, f]));
        expect(byName.syncOrders.signals).toEqual({
            exported: true, async: true, nesting: 2, lines: 7, removedGuard: true, sensitive: ['data-write', 'paging'],
        });
        expect(byName.label.signals).toMatchObject({ exported: false, async: false, nesting: 0, removedGuard: false, sensitive: [] });
        expect([byName.label.start, byName.label.end]).toEqual([8, 10]);
    });
});

describe('test files', () => {
    it('are never routed, however their fixtures read', () => {
        fs.mkdirSync(path.join(dir, '__tests__'));
        for (const file of ['sync.test.ts', 'sync.spec.js', '__tests__/sync.ts']) fs.writeFileSync(path.join(dir, file), SYNC);
        expect(rankChangedFunctions(dir, { 'sync.test.ts': [4], 'sync.spec.js': [4], '__tests__/sync.ts': [4] })).toEqual([]);
    });
});

describe('team lessons as a risk signal', () => {
    const lesson = (over: Partial<ReviewLesson>): ReviewLesson => ({
        id: 'l1', text: 'Trim before comparing names.', file: 'sync.ts', symbols: ['trimStart'], state: 'verified',
        evidence: [{ pr: 1, comment: 'c', author: 'r' }], createdAt: '', updatedAt: '', ...over,
    });
    const LABEL = 'function label(name) {\n  return name.trimStart();\n}\n';

    it('makes a plain function risky when a lesson for its file names a symbol it uses', () => {
        fs.writeFileSync(path.join(dir, 'sync.ts'), LABEL);
        const [f] = rankChangedFunctions(dir, { 'sync.ts': [2] }, {}, [lesson({})]);
        expect(f.signals.lesson).toBe('Trim before comparing names.');
        expect(f.score).toBeGreaterThanOrEqual(DEFAULT_MIN_SCORE);
    });

    it('ignores lessons for other files and lessons naming only common words', () => {
        fs.writeFileSync(path.join(dir, 'sync.ts'), LABEL);
        const other = rankChangedFunctions(dir, { 'sync.ts': [2] }, {}, [lesson({ file: 'other.ts' }), lesson({ symbols: ['name'] })]);
        expect(other[0].signals.lesson).toBeUndefined();
        expect(other[0].score).toBe(0);
    });
});

describe('scoreRisk', () => {
    it('ranks a data write behind a removed guard above a plain helper', () => {
        const risky: RiskSignals = { exported: true, async: true, nesting: 2, lines: 30, removedGuard: true, sensitive: ['data-write', 'paging'] };
        expect(scoreRisk(risky)).toBeGreaterThan(scoreRisk(plain));
    });

    it('gives a short, flat, private, non-sensitive function no model review', () => {
        expect(scoreRisk(plain)).toBe(0);
    });

    it('never scores below zero', () => {
        expect(scoreRisk({ ...plain, lines: 1 })).toBeGreaterThanOrEqual(0);
    });
});

describe('routeFiles', () => {
    it('always keeps files it cannot rank, and reports what it left to the gates', () => {
        fs.writeFileSync(path.join(dir, 'helper.ts'), 'function label(name) {\n  return name.trim();\n}\n');
        fs.writeFileSync(path.join(dir, 'query.py'), 'def f():\n    return 1\n');
        const routed = routeFiles(dir, ['helper.ts', 'query.py'], { 'helper.ts': [2], 'query.py': [2] }, {}, { min_score: 1 });
        expect([...routed.files]).toEqual(['query.py']);
        expect(routed.stats).toEqual({ functions: 1, routed: 0, files_skipped: 1, already_reviewed: 0 });
    });

    it('skips a risky function reviewed before at exactly this code, and only that code', () => {
        fs.writeFileSync(path.join(dir, 'sync.ts'), SYNC);
        const [risky] = rankChangedFunctions(dir, { 'sync.ts': [4] });
        const cleared = routeFiles(dir, ['sync.ts'], { 'sync.ts': [4] }, {}, {}, [{ file: 'sync.ts', function: 'syncOrders', hash: risky.hash }]);
        expect(cleared.stats).toMatchObject({ routed: 0, already_reviewed: 1, files_skipped: 1 });
        const stale = routeFiles(dir, ['sync.ts'], { 'sync.ts': [4] }, {}, {}, [{ file: 'sync.ts', function: 'syncOrders', hash: 'old' }]);
        expect(stale.stats).toMatchObject({ routed: 1, already_reviewed: 0 });
    });
});

describe('functionHash', () => {
    it('changes when anything inside the function changes, strings included', () => {
        const a = 'function f() { return "a  b"; }';
        const b = 'function f() { return "a b"; }';
        expect(functionHash(a)).not.toBe(functionHash(b));
        expect(functionHash('function f() { return `x ${y}`; }')).not.toBe(functionHash('function f() { return `x  ${y}`; }'));
    });

    it('treats a Windows checkout of the same code as the same code', () => {
        expect(functionHash('function f() {\r\n  return 1;\r\n}')).toBe(functionHash('function f() {\n  return 1;\n}'));
    });
});
