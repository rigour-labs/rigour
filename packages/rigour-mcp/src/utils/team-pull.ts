/**
 * The team database's lessons reach this server's agents through a sync, which pulls the team's promoted lessons
 * into the local store. A machine that has never pulled (a teammate's new clone, a cloud reviewer) would answer its
 * first recall from an empty store, so the first sync for a repository starts with the first tool call, and recall
 * waits a moment for it there; a machine that has pulled before answers at once while the sync runs behind it.
 */
import { hasPulledTeamLessons, loadTeamConfiguration, syncTeamOutbox } from '@rigour-labs/core';

/** How long a recall on a machine that has never pulled waits for the first team sync. */
const FIRST_SYNC_WAIT_MS = 8_000;

type FirstSync = { state: 'done' } | { state: 'off' } | { state: 'failed'; reason: string };

/** Where the team's lessons stand for a recall: in the local store, on their way, or not reachable. */
export type TeamLessonsState = { state: 'ready' } | { state: 'syncing' } | { state: 'failed'; reason: string };

const firstSync = new Map<string, Promise<FirstSync>>();

/**
 * The first team sync of this process for the repository at `cwd`: started once, never rejected. A failed one is
 * forgotten, so the next tool call tries again.
 */
export function firstTeamSync(cwd: string): Promise<FirstSync> {
    let sync = firstSync.get(cwd);
    if (!sync) {
        sync = (async (): Promise<FirstSync> => {
            if (!(await loadTeamConfiguration().catch(() => undefined))) return { state: 'off' };
            try {
                await syncTeamOutbox({ cwd });
                return { state: 'done' };
            } catch (error) {
                firstSync.delete(cwd);
                const reason = String(error instanceof Error ? error.message : error).split('\n')[0].trim().slice(0, 200);
                return { state: 'failed', reason };
            }
        })();
        firstSync.set(cwd, sync);
    }
    return sync;
}

/**
 * The team's lessons for a recall at `cwd`. On a machine that has pulled before they are in the local store already
 * (ready, no wait). Otherwise waits for the first sync, at most `waitMs`.
 */
export async function teamLessonsFor(cwd: string, waitMs = FIRST_SYNC_WAIT_MS): Promise<TeamLessonsState> {
    const sync = firstTeamSync(cwd);
    if (await hasPulledTeamLessons()) return { state: 'ready' };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), waitMs); });
    try {
        const outcome = await Promise.race([sync, late]);
        if (outcome === 'late') return { state: 'syncing' };
        return outcome.state === 'failed' ? outcome : { state: 'ready' };
    } finally {
        clearTimeout(timer);
    }
}
