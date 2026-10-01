import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rankChangedFunctions, scoreRisk, type RiskSignals } from './risk.js';
import { routeFiles } from './router.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const SYNC = [
    'export async function syncLeads(db, cursor) {',      // 1
    '  for (const page of pages(cursor)) {',               // 2
    '    if (page.rows.length) {',                         // 3
    "      await db.from('leads').upsert(page.rows);",     // 4
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
        expect(byName.syncLeads.signals).toEqual({
            exported: true, async: true, nesting: 2, lines: 7, removedGuard: true, sensitive: ['data-write', 'paging'],
        });
        expect(byName.label.signals).toMatchObject({ exported: false, async: false, nesting: 0, removedGuard: false, sensitive: [] });
        expect([byName.label.start, byName.label.end]).toEqual([8, 10]);
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
        const cleared = routeFiles(dir, ['sync.ts'], { 'sync.ts': [4] }, {}, {}, [{ file: 'sync.ts', function: 'syncLeads', hash: risky.hash }]);
        expect(cleared.stats).toMatchObject({ routed: 0, already_reviewed: 1, files_skipped: 1 });
        const stale = routeFiles(dir, ['sync.ts'], { 'sync.ts': [4] }, {}, {}, [{ file: 'sync.ts', function: 'syncLeads', hash: 'old' }]);
        expect(stale.stats).toMatchObject({ routed: 1, already_reviewed: 0 });
    });
});
