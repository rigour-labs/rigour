import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ team: null as null | object, pulled: false, sync: vi.fn(async (_options: { cwd: string }) => ({})) as ReturnType<typeof vi.fn> }));
vi.mock('@rigour-labs/core', () => ({
    loadTeamConfiguration: async () => core.team,
    hasPulledTeamLessons: async () => core.pulled,
    syncTeamOutbox: (options: { cwd: string }) => core.sync(options),
}));
const { firstTeamSync, teamLessonsFor } = await import('./team-pull.js');

// The first sync is per repository and per process: each test uses repositories of its own.
let n = 0;
const repo = () => `/repo-${++n}`;

beforeEach(() => {
    core.team = { teamId: 'web' };
    core.pulled = false;
    core.sync = vi.fn(async () => ({}));
});

describe('the team\'s lessons for a recall', () => {
    it('are ready at once without team mode, and nothing syncs', async () => {
        core.team = null;
        expect(await teamLessonsFor(repo(), 50)).toEqual({ state: 'ready' });
        expect(core.sync).not.toHaveBeenCalled();
    });

    it('start syncing once per repository however many tools are called', async () => {
        const [one, other] = [repo(), repo()];
        await Promise.all([firstTeamSync(one), firstTeamSync(one), teamLessonsFor(one, 50)]);
        await firstTeamSync(other);
        expect(core.sync.mock.calls).toEqual([[{ cwd: one }], [{ cwd: other }]]);
    });

    it('are still on their way while the first sync runs, then ready', async () => {
        let finish!: () => void;
        core.sync = vi.fn(() => new Promise(resolve => { finish = () => resolve({}); }));
        const one = repo();
        expect(await teamLessonsFor(one, 20)).toEqual({ state: 'syncing' });
        finish();
        expect(await teamLessonsFor(one, 20)).toEqual({ state: 'ready' });
    });

    it('are ready at once on a machine that has pulled before, while the sync runs behind', async () => {
        core.pulled = true;
        core.sync = vi.fn(() => new Promise(() => undefined));
        expect(await teamLessonsFor(repo(), 5_000)).toEqual({ state: 'ready' });
        expect(core.sync).toHaveBeenCalledTimes(1);
    });

    it('say why when the first sync fails, and the next call tries again', async () => {
        core.sync = vi.fn(async () => { throw new Error('Cannot reach the team database (ECONNREFUSED)\nmore detail'); });
        const one = repo();
        expect(await teamLessonsFor(one, 50)).toEqual({ state: 'failed', reason: 'Cannot reach the team database (ECONNREFUSED)' });
        core.sync = vi.fn(async () => ({}));
        expect(await teamLessonsFor(one, 50)).toEqual({ state: 'ready' });
        expect(core.sync).toHaveBeenCalledTimes(1);
    });
});
