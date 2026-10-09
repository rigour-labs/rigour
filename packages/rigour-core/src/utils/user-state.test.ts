import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { legacyStateNote, rigourUserDir } from './user-state.js';

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
        expect(legacyStateNote()).toBe(`Rigour state is in both ${path.join(dir, '.rigour')} and ${path.join(dir, '.rigour', '.rigour')}. This run uses ${path.join(dir, '.rigour', '.rigour')}, where your tools have been writing; merge the two by hand if you need both.`);
    });
});
