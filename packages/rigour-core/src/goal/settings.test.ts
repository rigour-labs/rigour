import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSettings, saveSettings } from '../settings.js';
import { ConfigSchema } from '../types/index.js';
import { resolveGoal, saveUserGoal } from './settings.js';

const team = (goal?: 'off' | 'on' | 'required') => ConfigSchema.parse({ version: 1, ...(goal ? { review: { goal } } : {}) });

describe('resolveGoal', () => {
    it('is off by default', () => {
        expect(resolveGoal(team(), undefined, undefined, {})).toEqual({ enabled: false, source: 'team', required: false, refused: [] });
    });

    it('takes the nearest layer: flag, then environment, then the person, then the team', () => {
        expect(resolveGoal(team('off'), true, false, { RIGOUR_GOAL: 'off' })).toMatchObject({ enabled: true, source: 'flag' });
        expect(resolveGoal(team('off'), undefined, false, { RIGOUR_GOAL: 'on' })).toMatchObject({ enabled: true, source: 'env' });
        expect(resolveGoal(team('on'), undefined, false, {})).toMatchObject({ enabled: false, source: 'user' });
        expect(resolveGoal(team('on'), undefined, undefined, {})).toMatchObject({ enabled: true, source: 'team' });
    });

    it('refuses, and reports, a nearer layer turning off a check the team requires', () => {
        for (const [flag, user, env] of [[false, undefined, {}], [undefined, undefined, { RIGOUR_GOAL: '0' }], [undefined, false, {}]] as const) {
            const resolved = resolveGoal(team('required'), flag, user, env);
            expect(resolved).toMatchObject({ enabled: true, source: 'team', required: true });
            expect(resolved.refused).toHaveLength(1);
            expect(resolved.refused[0]).toContain('review.goal: required');
        }
    });

    it('lets a nearer layer turn on what the team only allows', () => {
        expect(resolveGoal(team('required'), true, undefined, {})).toMatchObject({ enabled: true, source: 'flag', refused: [] });
    });

    it('reports an environment value it cannot read and falls through', () => {
        const resolved = resolveGoal(team('on'), undefined, undefined, { RIGOUR_GOAL: 'maybe' });
        expect(resolved).toMatchObject({ enabled: true, source: 'team' });
        expect(resolved.refused).toEqual(['RIGOUR_GOAL=maybe ignored: use on or off']);
    });
});

describe('saveUserGoal', () => {
    let home: string;
    const previous = process.env.RIGOUR_HOME;
    beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-goal-home-')); process.env.RIGOUR_HOME = home; });
    afterEach(() => {
        if (previous === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = previous;
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('stores the person\'s choice, and null goes back to the team\'s, keeping their other settings', () => {
        saveSettings({ reviewer: { mode: 'full' } });
        saveUserGoal(true);
        expect(loadSettings()).toEqual({ reviewer: { mode: 'full' }, goal: true });
        expect(resolveGoal(team('off'), undefined, loadSettings().goal, {})).toMatchObject({ enabled: true, source: 'user' });
        saveUserGoal(null);
        expect(loadSettings()).toEqual({ reviewer: { mode: 'full' } });
    });

    it('refuses anything but true, false or null', () => {
        expect(() => saveUserGoal('on')).toThrow('goal is true, false, or null');
        expect(fs.existsSync(path.join(home, '.rigour', 'settings.json'))).toBe(false);
    });
});
