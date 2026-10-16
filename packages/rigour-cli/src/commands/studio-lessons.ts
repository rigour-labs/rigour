/**
 * A person's decision on a fix or memory lesson from Studio's Memory page: keep, share with the team, drop, or take a
 * shared team memory back. Sharing and taking back are an sme's or owner's, as the last team sync read the role; the
 * team database refuses them from anyone else, and refusing here first keeps the local store from changing ahead of it.
 */
import { loadTeamConfiguration, readTeamAccess, sameRepositoryIds, takeBackTeamMemory, transitionLesson } from '@rigour-labs/core';

const STATES = new Set(['validated', 'promoted', 'rejected', 'superseded']);

/** Why this person may not share or take back a team lesson here; undefined when they may. */
async function whyNotDecider(): Promise<string | undefined> {
    const config = await loadTeamConfiguration().catch(() => null);
    if (!config) return 'Team mode is not configured: rigour team configure connects a team database.';
    const role = (await readTeamAccess(config))?.role;
    if (!role) return 'Your team role is not known yet: it is read at the first team sync (rigour team sync).';
    return role === 'sme' || role === 'owner' ? undefined : 'Only an sme or owner shares a team lesson or takes one back.';
}

export async function decideLessonFromStudio(cwd: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const { id, state, takeBack } = (body ?? {}) as { id?: unknown; state?: unknown; takeBack?: unknown };
    if (typeof id !== 'string' || (takeBack !== true && !STATES.has(String(state)))) {
        return { status: 400, body: { error: 'A lesson id and valid target state are required.' } };
    }
    const sharing = takeBack === true || state === 'promoted';
    const refused = sharing ? await whyNotDecider() : undefined;
    if (refused) return { status: 403, body: { error: refused } };
    if (takeBack === true) {
        const taken = await takeBackTeamMemory(id);
        return { status: taken ? 200 : 404, body: taken ? { success: true, state: taken } : { success: false } };
    }
    // A drop is sent too (a team lesson's only): the team database records it, so the next pull, which brings an sme
    // or owner members' candidates, never offers it again.
    const changed = await transitionLesson(id, state as 'validated' | 'promoted' | 'rejected' | 'superseded', {
        visibility: state === 'promoted' ? 'team' : undefined,
        queueSync: state === 'promoted' || state === 'rejected',
        repositoryIds: sameRepositoryIds(cwd),
    });
    return { status: changed ? 200 : 404, body: { success: changed } };
}
