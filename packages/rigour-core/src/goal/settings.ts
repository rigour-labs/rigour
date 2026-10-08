/**
 * Whether a review checks the change against the goal its pull request declares, and where that choice came from.
 * The reviewer's four layers, the nearest wins: a flag on this run (`--goal` / `--no-goal`), the environment
 * (`RIGOUR_GOAL=on|off`, for hooks and CI), the person's own settings (`goal` in the profile's settings.json), and the
 * team's rigour.yml (`review.goal`: off, on or required). `required` is the team's floor: a nearer layer that turns the
 * check off is refused, and the refusal is reported, never silent.
 */
import { loadSettings } from '../settings.js';
import type { Config } from '../types/index.js';
import type { Source } from '../review/reviewer/settings.js';

export interface ResolvedGoal {
    enabled: boolean;
    source: Source;
    /** The team requires the check: no nearer layer turns it off. */
    required: boolean;
    /** Nearer choices that were not applied, one line each, for the report. */
    refused: string[];
}

export function resolveGoal(config: Config, flag?: boolean, user: boolean | undefined = loadSettings().goal, env: NodeJS.ProcessEnv = process.env): ResolvedGoal {
    const team = config.review?.goal ?? 'off';
    const required = team === 'required';
    const refused: string[] = [];
    const raw = env.RIGOUR_GOAL?.trim().toLowerCase();
    const fromEnv = raw === 'on' || raw === '1' || raw === 'true' ? true : raw === 'off' || raw === '0' || raw === 'false' ? false : undefined;
    if (raw && fromEnv === undefined) refused.push(`RIGOUR_GOAL=${env.RIGOUR_GOAL} ignored: use on or off`);
    const near = ([['flag', flag], ['env', fromEnv], ['user', user]] as Array<[Source, boolean | undefined]>).find(([, value]) => value !== undefined);
    if (near && !(required && near[1] === false)) return { enabled: near[1]!, source: near[0], required, refused };
    if (near) refused.push(`goal check off (${near[0]}) refused: rigour.yml sets review.goal: required`);
    return { enabled: team !== 'off', source: 'team', required, refused };
}
