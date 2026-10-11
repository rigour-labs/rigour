import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositoryAllowed, withheldReason } from './team-scope.js';

const scope = { organizationId: 'acme', repositories: ['github.com/acme/*', 'https://GitLab.com/Acme/api'] };

describe('team scope', () => {
    it('sends lessons only from the repositories the team lists', () => {
        expect(repositoryAllowed('https://github.com/acme/web', scope)).toBe(true);
        expect(repositoryAllowed('https://gitlab.com/acme/api', scope)).toBe(true);
        expect(repositoryAllowed('https://gitlab.com/acme/api-internal', scope)).toBe(false);
        expect(repositoryAllowed('https://github.com/other-org/web', scope)).toBe(false);
        expect(repositoryAllowed('https://github.com/acme-evil/web', scope)).toBe(false);
    });

    it('sends nothing when the team lists no repositories', () => {
        expect(repositoryAllowed('https://github.com/acme/web', { organizationId: 'acme' })).toBe(false);
    });

    it('keeps personal lessons and unknown repositories on the machine, and says why', () => {
        expect(withheldReason('personal', 'https://github.com/acme/web', scope)).toBe('personal lesson');
        expect(withheldReason('personal', 'https://github.com/acme/web', { ...scope, syncPersonal: true })).toBeNull();
        expect(withheldReason('team', undefined, scope)).toBe('repository unknown on this machine');
        expect(withheldReason('team', 'https://github.com/other-org/web', scope)).toContain('github.com/other-org/web');
        expect(withheldReason('team', 'https://github.com/acme/web', scope)).toBeNull();
    });
});

describe("a repository whose origin uses an SSH host alias", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-alias-'));
    const config = path.join(configDir, 'config');
    fs.writeFileSync(config, 'Host work-forge\n    HostName forge.example.com\n    User git\n');
    beforeEach(() => vi.stubEnv('RIGOUR_SSH_CONFIG', config));
    afterEach(() => vi.unstubAllEnvs());
    afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));
    const team = (repositories: string[]) => ({ organizationId: 'org', repositories });

    it('is compared as the host the alias names in the ssh config', () => {
        // `git@work-forge:acme/api.git`, as Rigour records it.
        expect(repositoryAllowed('https://work-forge/acme/api', team(['forge.example.com/acme/*']))).toBe(true);
        expect(withheldReason('team', 'https://work-forge/other/api', team(['forge.example.com/acme/*'])))
            .toBe("repository work-forge/other/api (compared as forge.example.com/other/api, its SSH host resolved) is not one of the team's repositories");
    });

    it('matches a host-less pattern on the owner and repository alone', () => {
        expect(repositoryAllowed('https://work-forge/acme/api', team(['acme/*']))).toBe(true);
        expect(repositoryAllowed('https://forge.example.com/acme/api', team(['acme/api']))).toBe(true);
        expect(repositoryAllowed('https://forge.example.com/other/api', team(['acme/*']))).toBe(false);
    });

    it('leaves a host no alias names as it is, and says so plainly', () => {
        expect(repositoryAllowed('https://unknown-alias/acme/api', team(['forge.example.com/acme/*']))).toBe(false);
        expect(withheldReason('team', 'https://unknown-alias/acme/api', team(['forge.example.com/acme/*'])))
            .toBe("repository unknown-alias/acme/api is not one of the team's repositories");
    });
});
