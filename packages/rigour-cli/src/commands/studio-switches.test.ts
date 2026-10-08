import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStudioSwitch, saveStudioSwitch, switchNamed } from './studio-switches.js';

let repo: string;
let home: string;
const savedHome = process.env.RIGOUR_HOME;

beforeEach(() => {
    // A home of its own for the person's settings: never the real one, never another test's.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-home-goal-'));
    process.env.RIGOUR_HOME = home;
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-switch-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => {
    if (savedHome === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = savedHome;
    for (const dir of [repo, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a switch in Studio: the goal check', () => {
    it('names only the switches there are', () => {
        expect(switchNamed('goal')).toBe('goal');
        expect(switchNamed('toString')).toBeUndefined();
        expect(switchNamed('nothing')).toBeUndefined();
    });

    it('shows the default: off, from the team, no rigour.yml, no choice of yours', async () => {
        expect(await loadStudioSwitch(repo, 'goal')).toEqual({ effective: { enabled: false, source: 'team', required: false, refused: [] }, team: 'off', teamFile: false, user: null });
    });

    it('saves your own choice over the team\'s, and null goes back to the team\'s', async () => {
        expect(await saveStudioSwitch(repo, 'goal', { user: true })).toMatchObject({ user: true, effective: { enabled: true, source: 'user' } });
        expect(await saveStudioSwitch(repo, 'goal', { user: null })).toMatchObject({ user: null, effective: { enabled: false, source: 'team' } });
        await expect(saveStudioSwitch(repo, 'goal', { user: 'on' })).rejects.toThrow('goal is true, false, or null');
    });

    it('writes the team\'s to rigour.yml only when asked to create it, returns the diff, and the floor refuses your off', async () => {
        await expect(saveStudioSwitch(repo, 'goal', { team: 'required' })).rejects.toThrow('there is no rigour.yml');
        const saved = await saveStudioSwitch(repo, 'goal', { team: 'required', create: true });
        expect(saved).toMatchObject({ team: 'required', teamFile: true, effective: { enabled: true, required: true } });
        expect(saved.diff).toContain('goal: required');
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).toContain('goal: required');
        const refused = await saveStudioSwitch(repo, 'goal', { user: false });
        expect(refused.effective).toMatchObject({ enabled: true, source: 'team' });
        expect(refused.effective.refused).toEqual(['goal check off (user) refused: rigour.yml sets review.goal: required']);
    });

    it('refuses a team value that is not off, on, required or null, and a body that names both or neither', async () => {
        await expect(saveStudioSwitch(repo, 'goal', { team: 'always', create: true })).rejects.toThrow('team is off, on, required');
        await expect(saveStudioSwitch(repo, 'goal', { user: true, team: 'on' })).rejects.toThrow('send either user');
        await expect(saveStudioSwitch(repo, 'goal', {})).rejects.toThrow('send either user');
        expect(fs.existsSync(path.join(repo, 'rigour.yml'))).toBe(false);
    });
});
