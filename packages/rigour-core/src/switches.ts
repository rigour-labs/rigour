/**
 * A feature a team can turn off, on or require, and a person or a run can choose within that, as for the reviewer. Four
 * layers, the nearest wins: a flag on this run, an environment variable (hooks and CI take no flags), the person's own
 * settings (a key in the profile's settings.json), and the team's rigour.yml. `required` is the team's floor: a nearer
 * layer that turns the feature off is refused, and the refusal is reported, never silent.
 */
import { loadSettings, saveSettings, type RigourSettings } from './settings.js';
import type { Config } from './types/index.js';
import type { Source } from './review/reviewer/settings.js';

export type TeamSwitch = 'off' | 'on' | 'required';

interface SwitchDefinition {
    /** What a refusal calls it: "goal check off (user) refused". */
    label: string;
    env: string;
    /** Where the team's value lives in rigour.yml. */
    teamPath: string[];
    team: (config: Config) => TeamSwitch | undefined;
}

export const SWITCHES = {
    goal: { label: 'goal check', env: 'RIGOUR_GOAL', teamPath: ['review', 'goal'], team: config => config.review?.goal },
    outcomes: { label: 'outcome loop', env: 'RIGOUR_OUTCOMES', teamPath: ['learning', 'outcomes', 'mode'], team: config => config.learning?.outcomes?.mode },
} satisfies Record<string, SwitchDefinition>;

export type SwitchName = keyof typeof SWITCHES & keyof RigourSettings;

export interface ResolvedSwitch {
    enabled: boolean;
    source: Source;
    /** The team requires it: no nearer layer turns it off. */
    required: boolean;
    /** Nearer choices that were not applied, one line each, for the report. */
    refused: string[];
}

export function resolveSwitch(name: SwitchName, config: Config, flag?: boolean, user: boolean | undefined = loadSettings()[name], env: NodeJS.ProcessEnv = process.env): ResolvedSwitch {
    const definition: SwitchDefinition = SWITCHES[name];
    const team = definition.team(config) ?? 'off';
    const required = team === 'required';
    const refused: string[] = [];
    const given = env[definition.env];
    const raw = given?.trim().toLowerCase();
    const fromEnv = raw === 'on' || raw === '1' || raw === 'true' ? true : raw === 'off' || raw === '0' || raw === 'false' ? false : undefined;
    if (raw && fromEnv === undefined) refused.push(`${definition.env}=${given} ignored: use on or off`);
    const near = ([['flag', flag], ['env', fromEnv], ['user', user]] as Array<[Source, boolean | undefined]>).find(([, value]) => value !== undefined);
    if (near && !(required && near[1] === false)) return { enabled: near[1]!, source: near[0], required, refused };
    if (near) refused.push(`${definition.label} off (${near[0]}) refused: rigour.yml sets ${definition.teamPath.join('.')}: required`);
    return { enabled: team !== 'off', source: 'team', required, refused };
}

/** The person's own choice, from Studio: true or false sets it, `null` goes back to the team's. Returns what is stored. */
export function saveUserSwitch(name: SwitchName, value: unknown): boolean | undefined {
    if (value !== null && typeof value !== 'boolean') throw new Error(`${name} is true, false, or null for the team's`);
    const { [name]: _previous, ...settings } = loadSettings();
    saveSettings(value === null ? settings : { ...settings, [name]: value });
    return value ?? undefined;
}
