import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProfiles } from '@rigour-labs/core/profile';
import { profileAddCommand } from './profile.js';

let root: string;
const saved = process.env.RIGOUR_PROFILES;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-add-'));
    process.env.RIGOUR_PROFILES = path.join(root, 'profiles.json');
    vi.spyOn(console, 'log').mockImplementation(() => { });
});
afterEach(() => {
    if (saved === undefined) delete process.env.RIGOUR_PROFILES; else process.env.RIGOUR_PROFILES = saved;
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('rigour profile add --home', () => {
    it('keeps a new home ending in .rigour as one directory: the folder itself holds the state', () => {
        profileAddCommand('acme', { match: '~/work/acme', home: path.join(root, 'acme', '.rigour') });
        expect(readProfiles()[0].home).toBe(path.join(root, 'acme'));
        expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n')).toContain(`Its state: ${path.join(root, 'acme', '.rigour')}`);
    });

    it('keeps a home from before 6.11.1 as given, where its live state is nested', () => {
        const home = path.join(root, 'old', '.rigour');
        fs.mkdirSync(path.join(home, '.rigour'), { recursive: true });
        fs.writeFileSync(path.join(home, '.rigour', 'rigour.db'), '');
        profileAddCommand('old', { match: '~/work/old', home });
        expect(readProfiles()[0].home).toBe(home);
        expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n')).toContain(`Its state: ${path.join(home, '.rigour')}`);
    });

    it('leaves a home that does not end in .rigour as given', () => {
        profileAddCommand('beta', { match: '~/work/beta', home: path.join(root, 'beta') });
        expect(readProfiles()[0].home).toBe(path.join(root, 'beta'));
    });
});

describe('rigour profile add with a name already there', () => {
    it("replaces it where it is, says so, and the most specific profile still wins for its repository", async () => {
        const { profileMatch } = await import('@rigour-labs/core/profile');
        const repo = path.join(root, 'work', 'acme', 'api');
        fs.mkdirSync(repo, { recursive: true });
        profileAddCommand('acme', { match: repo });
        profileAddCommand('catch-all', { match: path.join(root, 'work') });
        profileAddCommand('acme', { match: repo, organization: 'acme', team: 'web', actor: 'dev' }); // re-added, after the catch-all
        expect(readProfiles().map(p => p.name)).toEqual(['acme', 'catch-all']);
        expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n')).toContain('Profile acme replaced');
        expect(profileMatch(repo)?.profile.name).toBe('acme');
    });
});
