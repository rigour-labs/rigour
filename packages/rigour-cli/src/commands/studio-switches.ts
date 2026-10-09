/**
 * Studio's switches (core's switches.ts: the goal check, ...): whether each runs, where that choice comes from, and the
 * person's and the team's settings. The person's goes to their settings.json; the team's to rigour.yml in the working
 * tree, never committed (studio-team-settings.ts).
 */
import fs from 'fs';
import path from 'path';
import { loadSettings, resolveSwitch, saveUserSwitch, SWITCHES, type ResolvedSwitch, type SwitchName, type TeamSwitch } from '@rigour-labs/core';
import { loadConfig } from './review-config.js';
import { writeTeamSettings } from './studio-team-settings.js';

export interface StudioSwitch {
    effective: ResolvedSwitch;
    team: TeamSwitch;
    /** Whether the team's setting comes from a rigour.yml, or is Rigour's default. */
    teamFile: boolean;
    /** The person's own choice; null when they left it to the team. */
    user: boolean | null;
}

/** A switch's name from a request path, or undefined when it names none. */
export function switchNamed(name: string): SwitchName | undefined {
    return Object.hasOwn(SWITCHES, name) ? name as SwitchName : undefined;
}

export async function loadStudioSwitch(cwd: string, name: SwitchName): Promise<StudioSwitch> {
    const config = await loadConfig(cwd, {});
    const user = loadSettings()[name];
    return {
        // Studio shows what a run here would do without a flag; the environment is the terminal's, not the person's choice.
        effective: resolveSwitch(name, config, undefined, user, {}),
        team: SWITCHES[name].team(config) ?? 'off',
        teamFile: fs.existsSync(path.join(cwd, 'rigour.yml')),
        user: user ?? null,
    };
}

/** `{ user: true | false | null }` changes the person's own; `{ team: 'off' | 'on' | 'required' | null, create? }` the team's. */
export async function saveStudioSwitch(cwd: string, name: SwitchName, body: unknown): Promise<StudioSwitch & { diff?: string }> {
    const payload = (body ?? {}) as { user?: unknown; team?: unknown; create?: unknown };
    if ('user' in payload === 'team' in payload) throw new Error('send either user (true, false or null) or team (off, on, required or null)');
    if ('user' in payload) {
        saveUserSwitch(name, payload.user);
        return loadStudioSwitch(cwd, name);
    }
    if (payload.team !== null && payload.team !== 'off' && payload.team !== 'on' && payload.team !== 'required') throw new Error('team is off, on, required, or null for Rigour\'s default');
    const diff = writeTeamSettings(cwd, [[SWITCHES[name].teamPath, payload.team]], payload.create === true);
    return { ...(await loadStudioSwitch(cwd, name)), diff };
}
