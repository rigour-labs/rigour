import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStateMerge, homeFor, legacyStateNote, planStateMerge, rigourUserDir } from './user-state.js';

let dir: string;
const set = process.env.RIGOUR_HOME;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-')); });
afterEach(() => {
    if (set === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = set;
    fs.rmSync(dir, { recursive: true, force: true });
});
const stateIn = (at: string) => { fs.mkdirSync(at, { recursive: true }); fs.writeFileSync(path.join(at, 'rigour.db'), ''); };

describe("Rigour's state directory", () => {
    it('is ~/.rigour without RIGOUR_HOME, and <RIGOUR_HOME>/.rigour for a home that does not end in .rigour', () => {
        delete process.env.RIGOUR_HOME;
        expect(rigourUserDir()).toBe(path.join(os.homedir(), '.rigour'));
        process.env.RIGOUR_HOME = path.join(dir, 'profile-home');
        expect(rigourUserDir()).toBe(path.join(dir, 'profile-home', '.rigour'));
        expect(legacyStateNote()).toBeUndefined();
    });

    it('is a RIGOUR_HOME ending in .rigour itself, never one level deeper', () => {
        process.env.RIGOUR_HOME = path.join(dir, '.rigour');
        expect(rigourUserDir()).toBe(path.join(dir, '.rigour'));
        expect(legacyStateNote()).toBeUndefined();
    });

    it('keeps state an earlier version wrote one level deeper, and doctor says how to move it', () => {
        process.env.RIGOUR_HOME = path.join(dir, '.rigour');
        stateIn(path.join(dir, '.rigour', '.rigour'));
        expect(rigourUserDir()).toBe(path.join(dir, '.rigour', '.rigour'));
        expect(legacyStateNote()).toContain('written by an earlier version');
        expect(legacyStateNote()).toContain(`move the contents of ${path.join(dir, '.rigour', '.rigour')} up one level`);
        expect(fs.existsSync(path.join(dir, '.rigour', '.rigour', 'rigour.db'))).toBe(true); // nothing moved
    });

    it('keeps the deeper one when both hold state, and doctor names both', () => {
        process.env.RIGOUR_HOME = path.join(dir, '.rigour');
        stateIn(path.join(dir, '.rigour'));
        stateIn(path.join(dir, '.rigour', '.rigour'));
        expect(rigourUserDir()).toBe(path.join(dir, '.rigour', '.rigour'));
        expect(legacyStateNote()).toBe(`Rigour state is in both ${path.join(dir, '.rigour')} and ${path.join(dir, '.rigour', '.rigour')}: a home ending in .rigour from before 6.11.1. ${path.join(dir, '.rigour', '.rigour')} is the live state, and this run uses it; ${path.join(dir, '.rigour')} holds what was left over. Merge the leftovers in, losing neither: rigour doctor --merge-state`);
    });
});

describe('rigour doctor --merge-state', () => {
    const write = (file: string, body = '') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
    const tree = (root: string) => {
        const out: string[] = [];
        const walk = (at: string, rel: string) => { for (const name of fs.readdirSync(at).sort()) { const full = path.join(at, name); const r = rel ? `${rel}/${name}` : name; if (fs.statSync(full).isDirectory()) walk(full, r); else out.push(r); } };
        walk(root, '');
        return out;
    };

    it("merges a pre-6.11.1 home's leftovers into the live state: moved where absent, kept aside where both, nothing lost", () => {
        const outer = path.join(dir, '.rigour');
        const live = path.join(outer, '.rigour');
        // The field layout: the outer directory, last written before 6.11.1, and the nested live one.
        for (const file of ['bin/llama-cli', 'models/lite.gguf', 'repos/abc/attempts.json']) write(path.join(outer, file), 'old');
        write(path.join(outer, 'version-cache.json'), 'old');
        write(path.join(outer, 'rigour.db'), 'old');
        for (const file of ['team-cache.key', 'telemetry-counters.json', 'runtime/semantic/package.json']) write(path.join(live, file), 'live');
        write(path.join(live, 'version-cache.json'), 'live');
        write(path.join(live, 'rigour.db'), 'live');
        process.env.RIGOUR_HOME = outer;
        const before = [...tree(outer)].length;

        const plan = planStateMerge('2026-10-11')!;
        expect(plan.live).toBe(live);
        expect(plan.steps.map(s => [s.action, s.rel])).toEqual([
            ['move', 'bin'], ['move', 'models'], ['move', 'repos'], ['aside', 'rigour.db'], ['aside', 'version-cache.json'],
        ]);
        expect(tree(outer).length).toBe(before); // planning changes nothing

        applyStateMerge(plan.steps);
        expect(tree(outer).length).toBe(before); // nothing deleted
        expect(fs.readFileSync(path.join(live, 'rigour.db'), 'utf8')).toBe('live'); // the live files are untouched
        expect(fs.readFileSync(path.join(live, 'version-cache.json'), 'utf8')).toBe('live');
        expect(fs.readFileSync(path.join(live, 'models/lite.gguf'), 'utf8')).toBe('old');
        expect(fs.readFileSync(path.join(outer, 'rigour.db.merged-2026-10-11'), 'utf8')).toBe('old');
        expect(fs.readdirSync(outer).sort()).toEqual(['.rigour', 'rigour.db.merged-2026-10-11', 'version-cache.json.merged-2026-10-11']);
        expect(rigourUserDir()).toBe(live); // still the live directory
        expect(planStateMerge('2026-10-11')).toBeUndefined(); // a second run finds nothing
    });

    it('merges a directory both hold entry by entry', () => {
        const outer = path.join(dir, '.rigour');
        const live = path.join(outer, '.rigour');
        write(path.join(outer, 'repos/a/state.json'), 'old');
        write(path.join(outer, 'repos/b/state.json'), 'old');
        write(path.join(live, 'repos/a/state.json'), 'live');
        process.env.RIGOUR_HOME = outer;
        const plan = planStateMerge('2026-10-11')!;
        expect(plan.steps.map(s => [s.action, s.rel])).toEqual([['aside', 'repos/a/state.json'], ['move', 'repos/b']]);
    });

    it('has nothing to do for a home in one directory', () => {
        process.env.RIGOUR_HOME = dir;
        stateIn(path.join(dir, '.rigour'));
        expect(planStateMerge()).toBeUndefined();
        expect(homeFor(path.join(dir, 'fresh', '.rigour'))).toBe(path.join(dir, 'fresh')); // a new home ending in .rigour is that folder
    });
});
