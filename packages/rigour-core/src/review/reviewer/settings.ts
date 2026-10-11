/**
 * The reviewer settings a run uses, and where each came from. Four layers, the nearest wins:
 * a flag on this run, an environment variable (hooks and CI take no flags), the person's own
 * settings (`reviewer` in the profile's settings.json, edited by hand or in Studio), and the team's
 * rigour.yml (its defaults when there is none). The team can set a floor no nearer layer goes
 * below: `panel: required` and `mode_required`. A nearer layer that asks for less is refused, and
 * the refusal is reported, never silent. Under a floor, a person also cannot turn reviews off, lower
 * the judges or escalate on risk only. A panel needs two vendors, so `panel` implies mode full,
 * except that a nearer choice of one judge turns off a panel the team only turned on.
 */
import { loadSettings, saveSettings, type UserReviewerSettings } from '../../settings.js';
import type { Config } from '../../types/index.js';

type Mode = 'single' | 'cross' | 'full';
export type Source = 'flag' | 'env' | 'user' | 'team';

/** What a single run asks for: `rigour review --reviewer --full | --single | --panel | --no-panel`. */
export interface RunChoice {
    mode?: Mode;
    panel?: boolean;
}

export interface ResolvedReviewer {
    enabled: boolean;
    on_push: 'background' | 'wait' | 'off';
    reviewers: string[];
    models: Record<string, string>;
    model?: string;
    timeout_ms: number;
    mode: Mode;
    panel: boolean;
    panel_max_items: number;
    /** Whether reviewer findings may be dismissed: the team's decision, never a person's. */
    dismissals: boolean;
    /** The daily caps that apply: the lower of the team's and the person's. */
    max_runs_per_day?: number;
    max_usd_per_day?: number;
    max_usd_per_review?: number;
    judges: 2 | 3;
    escalate: 'always' | 'risk';
    cross_models: Record<string, string>;
    /** The cheap model per reviewer name for cheap-model-first tiering; empty when it is off (team only). */
    tiers: Record<string, string>;
    /** Reasoning effort per reviewer name (codex, api). */
    reasoning: Record<string, 'low' | 'medium' | 'high'>;
    /** The API judge, when the team configured one (review.reviewer.api). */
    api?: { url: string; model: string; key_env: string; vendor?: 'anthropic' | 'openai' | 'google' | 'other'; max_turns: number };
    /** Environment variables each judge's CLI must not see (the team's, never a person's). */
    judge_env: Record<string, { unset: string[] }>;
    /** Where the mode and the panel choice came from. */
    source: { mode: Source; panel: Source };
    /** The team's floor: a run that cannot meet it is unavailable, never a quieter review. */
    required: { mode: boolean; panel: boolean };
    /** Nearer choices that were not applied (the team's floor, an unknown value), one line each, for the report. */
    refused: string[];
}

const RANK: Record<Mode, number> = { single: 0, cross: 1, full: 2 };
/** How near a layer is to this run: the nearer wins. */
const NEAR: Record<Source, number> = { flag: 0, env: 1, user: 2, team: 3 };

export function resolveReviewer(config: Config, choice: RunChoice = {}, user: UserReviewerSettings | undefined = loadSettings().reviewer, env: NodeJS.ProcessEnv = process.env): ResolvedReviewer {
    const team = config.review?.reviewer ?? { enabled: false, on_push: 'background' as const, reviewers: ['claude'], mode: 'single' as const, models: {}, timeout_ms: 15 * 60_000, panel: 'off' as const, mode_required: false, panel_max_items: 20, dismissals: false, orchestrator: 'off' as const, judges: 2 as const, escalate: 'always' as const, cross_models: {}, tiers: { cheap: {} }, judge_env: {}, reasoning: {} };
    const refused: string[] = [];
    const envMode = parseMode(env.RIGOUR_REVIEWER_MODE);
    const envPanel = parseSwitch(env.RIGOUR_REVIEWER_PANEL);
    if (env.RIGOUR_REVIEWER_MODE && !envMode) refused.push(`RIGOUR_REVIEWER_MODE=${env.RIGOUR_REVIEWER_MODE} ignored: use single, cross or full`);
    if (env.RIGOUR_REVIEWER_PANEL && envPanel === undefined) refused.push(`RIGOUR_REVIEWER_PANEL=${env.RIGOUR_REVIEWER_PANEL} ignored: use on or off`);
    const layers: Array<{ source: Source; mode?: Mode; panel?: boolean }> = [
        { source: 'flag', mode: choice.mode, panel: choice.panel },
        { source: 'env', mode: envMode, panel: envPanel },
        { source: 'user', mode: user?.mode, panel: user?.panel },
    ];
    const pick = <K extends 'mode' | 'panel'>(key: K) => layers.find(layer => layer[key] !== undefined);

    const requirePanel = team.panel === 'required';
    let panel = team.panel !== 'off';
    let panelSource: Source = 'team';
    const nearPanel = pick('panel');
    if (nearPanel) {
        if (requirePanel && nearPanel.panel === false) refused.push(`panel off (${nearPanel.source}) refused: rigour.yml sets review.reviewer.panel: required`);
        else [panel, panelSource] = [nearPanel.panel!, nearPanel.source];
    }

    let mode: Mode = team.mode;
    let modeSource: Source = 'team';
    const nearMode = pick('mode');
    if (nearMode) {
        if (team.mode_required && RANK[nearMode.mode!] < RANK[team.mode]) refused.push(`mode ${nearMode.mode} (${nearMode.source}) refused: rigour.yml sets review.reviewer.mode_required with mode ${team.mode}`);
        else [mode, modeSource] = [nearMode.mode!, nearMode.source];
    }
    if (panel && mode !== 'full') {
        // A panel needs two vendors. Asking for fewer judges at a nearer layer than the panel's turns the panel off, unless the team requires it.
        const fewer = nearMode && RANK[nearMode.mode!] < RANK.full;
        if (fewer && NEAR[nearMode.source] < NEAR[panelSource] && !requirePanel) panel = false;
        else {
            if (fewer) refused.push(`mode ${nearMode.mode} (${nearMode.source}) refused: ${requirePanel ? 'rigour.yml sets review.reviewer.panel: required' : `the panel (${panelSource}) needs judges from two vendors`}`);
            [mode, modeSource] = ['full', panelSource];
        }
    }
    const floor = requirePanel || team.mode_required;
    if (floor && team.enabled && user?.enabled === false) refused.push('reviews off (user) refused: rigour.yml requires the reviewer');
    if (floor && user?.judges !== undefined && user.judges < team.judges) refused.push(`judges ${user.judges} (user) refused: rigour.yml requires ${team.judges}`);

    return {
        enabled: floor && team.enabled ? true : user?.enabled ?? team.enabled,
        on_push: team.on_push,
        reviewers: user?.reviewers?.length ? user.reviewers : team.reviewers,
        models: { ...team.models, ...(user?.models ?? {}) },
        ...(team.model ? { model: team.model } : {}),
        timeout_ms: team.timeout_ms,
        mode,
        panel,
        panel_max_items: team.panel_max_items,
        dismissals: team.dismissals,
        ...cap('max_runs_per_day', team.max_runs_per_day, user?.max_runs_per_day, refused),
        ...cap('max_usd_per_day', team.max_usd_per_day, user?.max_usd_per_day, refused),
        ...cap('max_usd_per_review', team.max_usd_per_review, user?.max_usd_per_review, refused),
        judges: floor ? Math.max(team.judges, user?.judges ?? team.judges) as 2 | 3 : user?.judges ?? team.judges,
        escalate: requiredEscalation(team, user, refused),
        cross_models: team.cross_models,
        tiers: team.tiers?.cheap ?? {},
        judge_env: team.judge_env ?? {},
        reasoning: team.reasoning ?? {},
        ...(team.api ? { api: team.api } : {}),
        source: { mode: modeSource, panel: panelSource },
        required: { mode: team.mode_required, panel: requirePanel },
        refused,
    };
}

/** A cap is the lower of the team's and the person's: a person can spend less than the team allows, never more. */
function cap(key: 'max_runs_per_day' | 'max_usd_per_day' | 'max_usd_per_review', team: number | undefined, user: number | undefined, refused: string[]): Record<string, number> {
    if (user !== undefined && team !== undefined && user > team) refused.push(`${key} ${user} (user) refused: rigour.yml caps it at ${team}`);
    const value = team === undefined ? user : user === undefined ? team : Math.min(team, user);
    return value === undefined ? {} : { [key]: value };
}

/** A team that requires full or panel review wants it on every review: no user may escalate on risk only. */
function requiredEscalation(team: { escalate: 'always' | 'risk'; panel: string; mode_required: boolean }, user: UserReviewerSettings | undefined, refused: string[]): 'always' | 'risk' {
    const required = team.panel === 'required' || team.mode_required;
    if (required && user?.escalate === 'risk') refused.push('escalate risk (user) refused: rigour.yml requires every review to be full');
    return required ? 'always' : user?.escalate ?? team.escalate;
}

function parseMode(value: string | undefined): Mode | undefined {
    return value === 'single' || value === 'cross' || value === 'full' ? value : undefined;
}

function parseSwitch(value: string | undefined): boolean | undefined {
    if (/^(1|on|true|yes)$/i.test(value ?? '')) return true;
    if (/^(0|off|false|no)$/i.test(value ?? '')) return false;
    return undefined;
}

/** A change to the person's own reviewer settings: a value sets it, `null` goes back to the team's. */
export type UserReviewerPatch = { [K in keyof UserReviewerSettings]?: UserReviewerSettings[K] | null };

/** Applies a validated patch to the person's settings (settings.json in the profile's home) and returns what is stored. */
export function saveUserReviewer(patch: UserReviewerPatch): UserReviewerSettings {
    const problem = patchProblem(patch);
    if (problem) throw new Error(problem);
    const settings = loadSettings();
    const next: Record<string, unknown> = { ...(settings.reviewer ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
    }
    saveSettings({ ...settings, reviewer: next as UserReviewerSettings });
    return next as UserReviewerSettings;
}

function patchProblem(patch: UserReviewerPatch): string | undefined {
    const known = new Set(['enabled', 'mode', 'panel', 'judges', 'escalate', 'reviewers', 'models', 'max_runs_per_day', 'max_usd_per_day', 'max_usd_per_review']);
    const unknown = Object.keys(patch).find(key => !known.has(key));
    if (unknown) return `not a reviewer setting a person can change: ${unknown}`;
    const ok = (value: unknown, test: (v: unknown) => boolean) => value === null || value === undefined || test(value);
    if (!ok(patch.enabled, v => typeof v === 'boolean')) return 'enabled is true or false';
    if (!ok(patch.mode, v => v === 'single' || v === 'cross' || v === 'full')) return 'mode is single, cross or full';
    if (!ok(patch.panel, v => typeof v === 'boolean')) return 'panel is true or false';
    if (!ok(patch.judges, v => v === 2 || v === 3)) return 'judges is 2 or 3';
    if (!ok(patch.escalate, v => v === 'always' || v === 'risk')) return 'escalate is always or risk';
    if (!ok(patch.max_runs_per_day, v => Number.isInteger(v) && (v as number) > 0)) return 'max_runs_per_day is a whole number above 0';
    if (!ok(patch.max_usd_per_day, v => typeof v === 'number' && v > 0)) return 'max_usd_per_day is a number above 0';
    if (!ok(patch.max_usd_per_review, v => typeof v === 'number' && v > 0)) return 'max_usd_per_review is a number above 0';
    if (!ok(patch.reviewers, v => Array.isArray(v) && v.every(x => x === 'claude' || x === 'cursor' || x === 'codex'))) return 'reviewers lists claude, cursor or codex';
    // A model name is handed to an agent CLI as an argument: one that starts with "-" would be read as a flag.
    if (!ok(patch.models, v => !!v && typeof v === 'object' && Object.values(v).every(x => typeof x === 'string' && /^[\w.:/@-]+$/.test(x) && !x.startsWith('-')))) return 'models maps a reviewer to a model name (letters, digits and . : / @ -, not starting with -)';
    return undefined;
}
