import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ calls: [] as Array<[string, string]>, team: null as null | Record<string, unknown>, sync: (async () => ({ synced: 1 })) as () => Promise<unknown>, sendState: { state: 'sent' } as Record<string, unknown> }));
vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    shareMemoryLesson: async (_cwd: string, key: string, value: string) => { shared.calls.push([key, value]); return 'lesson-1'; },
    loadTeamConfiguration: async () => shared.team,
    syncTeamOutbox: () => shared.sync(),
    teamSendStateOf: async () => shared.sendState,
}));

const { handleForget, handleRemember } = await import('./memory-handlers.js');
const { handleRecall } = await import('./memory-recall.js');

let repoA: string;
let repoB: string;
let home: string;
const realHome = process.env.RIGOUR_HOME;
const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');

beforeEach(() => {
    repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-a-'));
    repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-b-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-home-'));
    process.env.RIGOUR_HOME = home;
    shared.calls = [];
    shared.team = null;
    shared.sync = async () => ({ synced: 1 });
    shared.sendState = { state: 'sent' };
});
afterEach(() => {
    if (realHome === undefined) delete process.env.RIGOUR_HOME;
    else process.env.RIGOUR_HOME = realHome;
    for (const dir of [repoA, repoB, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory scopes', () => {
    it("never returns another repository's memory", async () => {
        await handleRemember(repoA, 'deploy', 'Only deploy from main.');
        expect(text(await handleRecall(repoA))).toContain('Only deploy from main.');
        expect(text(await handleRecall(repoB))).not.toContain('Only deploy from main.');
    });

    it('reflects a memory added or forgotten since the last recall', async () => {
        await handleRemember(repoA, 'tests', 'Run vitest before committing.');
        expect(text(await handleRecall(repoA, { key: 'tests' }))).toContain('Run vitest');
        await handleRemember(repoA, 'db', 'Use the read replica for reports.');
        expect(text(await handleRecall(repoA))).toContain('read replica');
        await handleForget(repoA, 'tests');
        expect(text(await handleRecall(repoA, { key: 'tests' }))).toContain('NO MEMORY FOUND');
    });

    it('keeps a user memory for every repository, and lets a repository memory override it', async () => {
        await handleRemember(repoA, 'pr_size', 'Keep pull requests small.', 'user');
        expect(text(await handleRecall(repoB, { key: 'pr_size' }))).toContain('(user)');
        await handleRemember(repoB, 'pr_size', 'This repo allows one large migration PR.');
        expect(text(await handleRecall(repoB, { key: 'pr_size' }))).toContain('large migration');
        expect(text(await handleRecall(repoA, { key: 'pr_size' }))).toContain('Keep pull requests small.');
    });

    it('stores a team memory for the repository and shares it as a candidate, saying when teammates get it', async () => {
        const result = text(await handleRemember(repoA, 'retries', 'Use withRetry from lib/net.', 'team'));
        expect(shared.calls).toEqual([['retries', 'Use withRetry from lib/net.']]);
        expect(result).toContain('team mode is configured');
        expect(text(await handleRecall(repoA, { key: 'retries' }))).toContain('withRetry');
    });

    describe('in team mode', () => {
        const sshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ssh-'));
        const sshConfig = path.join(sshDir, 'config');
        fs.writeFileSync(sshConfig, 'Host remember-forge\n    HostName forge.example.com\n    User git\n');
        const withOrigin = (dir: string, url: string) => {
            fs.mkdirSync(path.join(dir, '.git'));
            fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
        };
        beforeEach(() => {
            vi.stubEnv('RIGOUR_SSH_CONFIG', sshConfig);
            vi.stubEnv('RIGOUR_TEAM_REPOSITORIES', '');
            shared.team = { organizationId: 'example-org', teamId: 'platform', actorId: 'dev-a', repositories: ['forge.example.com/example-org/api'] };
        });
        afterEach(() => vi.unstubAllEnvs());
        afterAll(() => fs.rmSync(sshDir, { recursive: true, force: true }));

        it("says a memory from a repository the team does not list is kept, and how to add it, alias resolved", async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/widgets.git');
            const result = text(await handleRemember(repoA, 'retries', 'Use withRetry from lib/net.', 'team'));
            expect(shared.calls).toEqual([['retries', 'Use withRetry from lib/net.']]);
            expect(result).toContain("Kept as a team candidate on this machine; it is sent once this repository is in the team's list: rigour team configure … --repositories 'forge.example.com/example-org/api,forge.example.com/example-org/widgets'");
            expect(result).not.toContain('Shared with your team');
        });

        it('names the environment variable when the team list comes from it', async () => {
            vi.stubEnv('RIGOUR_TEAM_REPOSITORIES', 'forge.example.com/example-org/api');
            withOrigin(repoA, 'https://forge.example.com/example-org/widgets.git');
            expect(text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'))).toContain("set RIGOUR_TEAM_REPOSITORIES='forge.example.com/example-org/api,forge.example.com/example-org/widgets'");
        });

        it('says it reached the team database only once a sync sent it', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            expect(text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'))).toContain('Sent to the team database as a candidate');
        });

        it('says NOT SENT when the sync ran but the team database refused this candidate', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            shared.sendState = { state: 'not sent', reason: 'refused by the team database: permission denied' };
            const result = text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'));
            expect(result).toContain('NOT SENT: the team database did not take this candidate (refused by the team database: permission denied).');
            expect(result).not.toContain('Sent to the team database');
        });

        it('says NOT SENT, and why, when the sync failed before sending it', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            shared.sendState = { state: 'queued', reason: 'connect ECONNREFUSED' };
            shared.sync = async () => { throw new Error('Cannot reach the team database (ECONNREFUSED)\nmore'); };
            const result = text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'));
            expect(result).toContain('NOT SENT: saved as a team candidate on this machine only; the sync failed (Cannot reach the team database (ECONNREFUSED)).');
            expect(result).not.toContain('Sent to the team database');
        });

        it('says sent when the sync failed after sending it (a later item, or the pull)', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            shared.sync = async () => { throw new Error('pull failed'); };
            const result = text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'));
            expect(result).toContain('Sent to the team database as a candidate.');
            expect(result).not.toContain('NOT SENT');
        });

        it('says it is already in the team database when another checkout saved it first', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            shared.sendState = { state: 'in the team database' };
            expect(text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'))).toContain('Already a team candidate in the team database');
        });

        it('says held, with the reason, when the candidate waits', async () => {
            withOrigin(repoA, 'git@remember-forge:example-org/api.git');
            shared.sendState = { state: 'held', reason: 'waiting for the team list' };
            expect(text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'))).toContain('held: waiting for the team list.');
        });

        it('says a repository with no origin remote is not sent', async () => {
            expect(text(await handleRemember(repoA, 'retries', 'Use withRetry.', 'team'))).toContain('this repository has no origin remote');
        });
    });

    it('records memory_stored for Studio', async () => {
        await handleRemember(repoA, 'naming', 'Hooks are named useX.');
        const events = fs.readFileSync(path.join(repoA, '.rigour', 'events.jsonl'), 'utf8');
        expect(events).toContain('"type":"memory_stored"');
    });
});

describe('RIGOUR_USER_MEMORY=off', () => {
    beforeEach(() => { process.env.RIGOUR_USER_MEMORY = 'off'; });
    afterEach(() => { delete process.env.RIGOUR_USER_MEMORY; });

    it("never reads the user's memory, so a sandboxed server cannot surface another repository's notes", async () => {
        fs.mkdirSync(path.join(home, '.rigour'));
        fs.writeFileSync(path.join(home, '.rigour', 'memory.json'), JSON.stringify({ memories: { infra: { value: 'Other employer host list.', timestamp: 't' } } }));
        await handleRemember(repoA, 'deploy', 'Only deploy from main.');
        const recalled = text(await handleRecall(repoA));
        expect(recalled).toContain('Only deploy from main.');
        expect(recalled).not.toContain('Other employer host list.');
        expect(text(await handleRecall(repoA, { key: 'infra' }))).toContain('NO MEMORY FOUND');
    });

    it('refuses to store or forget a user memory, and writes nothing to the home', async () => {
        expect(text(await handleRemember(repoA, 'style', 'Prefer tabs.', 'user'))).toContain('RIGOUR_USER_MEMORY=off');
        expect(text(await handleForget(repoA, 'style', 'user'))).toContain('RIGOUR_USER_MEMORY=off');
        expect(fs.readdirSync(home)).toEqual([]);
    });
});
