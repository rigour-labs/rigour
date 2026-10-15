/**
 * The team database's lessons reach this server's agents through a sync, which pulls the team's promoted lessons
 * into the local store. A fresh machine (a teammate's new clone, a cloud reviewer) has pulled nothing yet, so the
 * first sync for a repository starts with the first tool call, and recall waits a moment for it rather than
 * answering "nothing" from an empty store.
 */
import { loadTeamConfiguration, syncTeamOutbox } from '@rigour-labs/core';

/** How long a recall waits for the first team sync before answering with what this machine already holds. */
const FIRST_SYNC_WAIT_MS = 8_000;

const firstSync = new Map<string, Promise<void>>();

/** The first team sync of this process for the repository at `cwd`: started once, never rejected. Nothing without team mode. */
export function firstTeamSync(cwd: string): Promise<void> {
    let sync = firstSync.get(cwd);
    if (!sync) {
        sync = (async () => {
            if (!(await loadTeamConfiguration().catch(() => undefined))) return;
            await syncTeamOutbox({ cwd });
        })().catch(() => undefined);
        firstSync.set(cwd, sync);
    }
    return sync;
}

/**
 * Waits for the first team sync, at most `waitMs`. True when it is done (or there is no team mode); false when it is
 * still running, so the caller can say the team's lessons are on their way.
 */
export async function awaitFirstTeamSync(cwd: string, waitMs = FIRST_SYNC_WAIT_MS): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), waitMs); });
    try {
        return await Promise.race([firstTeamSync(cwd).then(() => true as const), late]);
    } finally {
        clearTimeout(timer);
    }
}
