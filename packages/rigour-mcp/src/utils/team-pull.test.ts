import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ team: null as null | object, sync: vi.fn(async (_options: { cwd: string }) => ({})) as ReturnType<typeof vi.fn> }));
vi.mock('@rigour-labs/core', () => ({
    loadTeamConfiguration: async () => core.team,
    syncTeamOutbox: (options: { cwd: string }) => core.sync(options),
}));
const { awaitFirstTeamSync, firstTeamSync } = await import('./team-pull.js');

// The first sync is per repository and per process: each test uses repositories of its own.
let n = 0;
const repo = () => `/repo-${++n}`;

beforeEach(() => {
    core.team = null;
    core.sync = vi.fn(async () => ({}));
});

describe('the first team sync of a server process', () => {
    it('does nothing without team mode, and recall need not wait', async () => {
        expect(await awaitFirstTeamSync(repo(), 50)).toBe(true);
        expect(core.sync).not.toHaveBeenCalled();
    });

    it('starts once per repository however many tools are called', async () => {
        core.team = { teamId: 'web' };
        const [one, other] = [repo(), repo()];
        await Promise.all([firstTeamSync(one), firstTeamSync(one), awaitFirstTeamSync(one, 50)]);
        await firstTeamSync(other);
        expect(core.sync.mock.calls).toEqual([[{ cwd: one }], [{ cwd: other }]]);
    });

    it('says when it is still running, then that it is done', async () => {
        core.team = { teamId: 'web' };
        let finish!: () => void;
        core.sync = vi.fn(() => new Promise(resolve => { finish = () => resolve({}); }));
        const one = repo();
        expect(await awaitFirstTeamSync(one, 20)).toBe(false);
        finish();
        expect(await awaitFirstTeamSync(one, 20)).toBe(true);
    });

    it('never rejects when the sync fails', async () => {
        core.team = { teamId: 'web' };
        core.sync = vi.fn(async () => { throw new Error('connection refused'); });
        await expect(awaitFirstTeamSync(repo(), 50)).resolves.toBe(true);
    });
});
