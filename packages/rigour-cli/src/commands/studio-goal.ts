/**
 * Studio's "Goal check" (docs/GOAL.md): whether reviews check a change against the goal its pull request declares,
 * where that choice comes from, and the person's and the team's settings. The person's goes to their settings.json; the
 * team's to rigour.yml in the working tree, never committed (studio-team-settings.ts).
 */
import fs from 'fs';
import path from 'path';
import { loadSettings, resolveGoal, saveUserGoal, type ResolvedGoal } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';
import { writeTeamSettings } from './studio-team-settings.js';

export interface StudioGoal {
    effective: ResolvedGoal;
    team: 'off' | 'on' | 'required';
    /** Whether the team's setting comes from a rigour.yml, or is Rigour's default. */
    teamFile: boolean;
    /** The person's own choice; null when they left it to the team. */
    user: boolean | null;
}

export async function loadStudioGoal(cwd: string): Promise<StudioGoal> {
    const config = await loadConfig(cwd, {});
    const user = loadSettings().goal;
    return {
        // Studio shows what a run here would do without a flag; the environment is the terminal's, not the person's choice.
        effective: resolveGoal(config, undefined, user, {}),
        team: config.review?.goal ?? 'off',
        teamFile: fs.existsSync(path.join(cwd, 'rigour.yml')),
        user: user ?? null,
    };
}

/** `{ user: true | false | null }` changes the person's own; `{ team: 'off' | 'on' | 'required' | null, create? }` the team's. */
export async function saveStudioGoal(cwd: string, body: unknown): Promise<StudioGoal & { diff?: string }> {
    const payload = (body ?? {}) as { user?: unknown; team?: unknown; create?: unknown };
    if ('user' in payload === 'team' in payload) throw new Error('send either user (true, false or null) or team (off, on, required or null)');
    if ('user' in payload) {
        saveUserGoal(payload.user);
        return loadStudioGoal(cwd);
    }
    if (payload.team !== null && payload.team !== 'off' && payload.team !== 'on' && payload.team !== 'required') throw new Error('team is off, on, required, or null for Rigour\'s default');
    const diff = writeTeamSettings(cwd, [[['review', 'goal'], payload.team]], payload.create === true);
    return { ...(await loadStudioGoal(cwd)), diff };
}
