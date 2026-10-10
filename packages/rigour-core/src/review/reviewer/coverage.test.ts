import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changedUnits, unaccounted, unitsText } from './coverage.js';

/** The cap in coverage.ts. */
const MAX_UNITS = 25;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const diffFor = (file: string, hunks: Array<{ start: number; context: string; added: string[] }>) => [
    `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    ...hunks.flatMap(h => [`@@ -${h.start},1 +${h.start},${h.added.length} @@ ${h.context}`, ...h.added.map(l => `+${l}`)]),
].join('\n');

describe('changed units', () => {
    it('names a parsed function, a hunk by the code around it in any language, and skips lockfiles and prose', () => {
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export function load(id: string) {\n    return id;\n}\n');
        const diff = [
            diffFor('src/a.ts', [{ start: 1, context: '', added: ['export function load(id: string) {', '    return id;', '}'] }]),
            diffFor('conn/conn.go', [{ start: 40, context: 'func (c *Conn) Close() error {', added: ['\tc.mu.Lock()', '\tdefer c.mu.Unlock()'] }, { start: 90, context: 'func (c *Conn) Close() error {', added: ['\treturn nil'] }]),
            diffFor('yarn.lock', [{ start: 1, context: '', added: ['x'] }]),
            diffFor('README.md', [{ start: 1, context: '', added: ['words'] }]),
        ].join('\n');
        const { units, total } = changedUnits(dir, diff);
        // One scale for both kinds: three added lines each, so the tie goes by file name.
        expect(units.map(u => `${u.file} :: ${u.name}`)).toEqual(['conn/conn.go :: func (c *Conn) Close() error {', 'src/a.ts :: load']);
        expect(units[0]).toMatchObject({ start: 40, end: 90 }); // two hunks of one function are one unit
        expect(total).toBe(2);
    });

    it('ranks a large hunk in any language above a small parsed function: one scale, not the parser first', () => {
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export function tiny() {\n    return 1;\n}\n');
        const diff = [
            diffFor('src/a.ts', [{ start: 2, context: '', added: ['    return 1;'] }]),
            diffFor('pkg/big.go', [{ start: 10, context: 'func Big() {', added: Array.from({ length: 30 }, () => '\tx := 1') }]),
        ].join('\n');
        expect(changedUnits(dir, diff).units.map(u => u.file)).toEqual(['pkg/big.go', 'src/a.ts']);
    });

    it('offers at most MAX_UNITS, largest first, and says how many more there are', () => {
        const diff = Array.from({ length: MAX_UNITS + 3 }, (_, i) => diffFor(`pkg/f${i}.py`, [{ start: 1, context: `def f${i}():`, added: Array.from({ length: i + 1 }, () => 'x = 1') }])).join('\n');
        const { units, total } = changedUnits(dir, diff);
        expect(units).toHaveLength(MAX_UNITS);
        expect(total).toBe(MAX_UNITS + 3);
        expect(units[0].file).toBe(`pkg/f${MAX_UNITS + 2}.py`);
        expect(unitsText(units, total - units.length)).toContain('3 more changed unit(s) are not in this list');
    });

    it('counts a unit accounted only when the answer names its file and the unit, with a note', () => {
        const units = [{ file: 'a.go', name: 'func (c *Conn) Close() error {', start: 1, end: 5 }, { file: 'b.ts', name: 'load', start: 1, end: 3 }];
        expect(unaccounted(units, [
            { file: 'a.go', unit: 'Close', status: 'fine', note: 'unlocks on every path' },
            { file: 'b.ts', unit: 'load', status: 'fine', note: '' },
        ], []).map(u => u.name)).toEqual(['load']);
    });

    it('lets one entry account for one unit: a short name matching several units of a file accounts for none of them', () => {
        const units = ['handleOpen', 'handleClose', 'handleRead'].map((name, i) => ({ file: 'a.ts', name, start: i * 10 + 1, end: i * 10 + 5 }));
        expect(unaccounted(units, [{ file: 'a.ts', unit: 'handle', status: 'fine', note: 'checked' }], [])).toHaveLength(3);
        // Exact names match one each; the same entry twice still accounts for one.
        const twice = { file: 'a.ts', unit: 'handleRead', status: 'fine' as const, note: 'checked' };
        expect(unaccounted(units, [twice, twice], []).map(u => u.name)).toEqual(['handleOpen', 'handleClose']);
    });

    it('counts a "finding" entry only for a surviving finding inside the unit\'s lines', () => {
        const units = [{ file: 'a.ts', name: 'load', start: 10, end: 20 }];
        const entry = { file: 'a.ts', unit: 'load', status: 'finding' as const, note: 'the unbounded read' };
        expect(unaccounted(units, [entry], [])).toHaveLength(1);
        expect(unaccounted(units, [entry], [{ file: 'a.ts', line: 40 }])).toHaveLength(1);
        expect(unaccounted(units, [entry], [{ file: 'a.ts', line: 22 }])).toHaveLength(0); // within the slack
    });
});
