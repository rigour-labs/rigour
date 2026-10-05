import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProfile, hostPath, profileFor, profileMismatch, type RigourProfile } from './profile.js';

let root: string;
const saved = { ...process.env };
const repo = (rel: string, remote?: string) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    return dir;
};

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'))); });
afterEach(() => { process.env = { ...saved }; fs.rmSync(root, { recursive: true, force: true }); });

describe('profiles', () => {
    it('matches a repository by path prefix or by origin remote, first match winning', () => {
        const byPath = repo('work/acme/api');
        const byRemote = repo('elsewhere/web', 'git@github.com:Acme/web.git');
        const other = repo('personal/tool', 'https://github.com/me/tool');
        const profiles: RigourProfile[] = [
            { name: 'acme-path', match: [path.join(root, 'work/acme')] },
            { name: 'acme-remote', match: ['github.com/acme/*'] },
        ];
        expect(profileFor(path.join(byPath, 'src'), profiles)?.name).toBe('acme-path');
        expect(profileFor(byRemote, profiles)?.name).toBe('acme-remote');
        expect(profileFor(other, profiles)).toBeUndefined();
        expect(profileFor(path.join(root, 'work/acme-evil'), profiles)).toBeUndefined();
        expect(hostPath('https://GitHub.com/Acme/web.git/')).toBe('github.com/acme/web');
    });

    it("applies the profile's home and team, clearing team settings inherited from the shell", () => {
        const dir = repo('work/acme/api');
        process.env.RIGOUR_TEAM_DATABASE_URL = 'postgres://other-org';
        process.env.RIGOUR_ORGANIZATION_ID = 'other-org';
        applyProfile(dir, [{ name: 'acme', match: [path.join(root, 'work/acme')], home: path.join(root, 'acme-home'), githubAccount: 'acme-dev' }]);
        expect(process.env.RIGOUR_HOME).toBe(path.join(root, 'acme-home'));
        expect(process.env.RIGOUR_PROFILE).toBe('acme');
        expect(process.env.RIGOUR_GITHUB_ACCOUNT).toBe('acme-dev');
        expect(process.env.RIGOUR_TEAM_DATABASE_URL).toBeUndefined();
        expect(process.env.RIGOUR_ORGANIZATION_ID).toBeUndefined();

        applyProfile(dir, [{ name: 'acme', match: [dir], team: { organization: 'acme', team: 'web', actor: 'dev', repositories: ['github.com/acme/*'], databaseUrlCommand: 'echo url' } }]);
        expect([process.env.RIGOUR_ORGANIZATION_ID, process.env.RIGOUR_TEAM_REPOSITORIES, process.env.RIGOUR_TEAM_DATABASE_URL_COMMAND]).toEqual(['acme', 'github.com/acme/*', 'echo url']);
    });

    it('refuses to act for a repository of another profile than the one the process started with', () => {
        const acme = repo('work/acme/api');
        const mine = repo('personal/tool');
        const profiles: RigourProfile[] = [{ name: 'acme', match: [path.join(root, 'work/acme')] }];
        delete process.env.RIGOUR_PROFILE;
        expect(profileMismatch(mine, profiles)).toBeNull();
        expect(profileMismatch(acme, profiles)).toContain('belongs to the Rigour profile "acme"');
        process.env.RIGOUR_PROFILE = 'acme';
        expect(profileMismatch(acme, profiles)).toBeNull();
        expect(profileMismatch(mine, profiles)).toContain('started as "acme"');
    });
});
