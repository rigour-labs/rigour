/**
 * What a backtest round holds fixed to its commit's time, besides the code: the settings, the dependencies, what the
 * reviewer learned, and where its judges may look. Each round's report says which of these were the commit's and which
 * were today's, so a number is never read as more faithful than it was.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { ConfigSchema, type Config } from '../types/index.js';
import type { LessonCutoffReport } from '../review-learning/lesson-cutoff.js';
import { describeDependencies, type DependencyUse } from './backtest-deps.js';
import type { Exec } from './reviewer.js';
import type { ReviewRecord } from './reviewer/record.js';

/** What a round ran with, on its report. */
export interface Replay {
    /** The moment lessons are cut off at, and where it came from. */
    asOf: string;
    config: string;
    dependencies: DependencyUse;
    lessons?: LessonCutoffReport;
    /** RIGOUR_REVIEW_LESSONS was set, and not read. */
    lessonsEnvIgnored?: string;
    /** Judges that read the machine's own memory or settings, each with what (the review's record says it). */
    judgesNotIsolated?: string[];
}

export interface ConfigChoice {
    /** Today's settings, as the command loaded them (rigour.yml, the file -c names, or the defaults). */
    today: Config;
    /** The checkout the command runs in: whether today's rigour.yml exists. */
    cwd: string;
    /** Keep today's settings for every round (`--config-now`). */
    now?: boolean;
    /** The file -c named: used exactly as it is today, never read at the commit. */
    file?: string;
}

const CONFIG = 'rigour.yml';

/**
 * The settings the round reviews with: the file -c names as it is today; else the commit's rigour.yml; else, when the
 * commit had none or it does not parse, today's (so a repository that adopted Rigour later still reviews with its
 * settings, and says so). `--config-now` keeps today's.
 */
export function configAtCommit(worktree: string, choice: ConfigChoice): { config: Config; source: string } {
    const today = (why: string) => ({ config: choice.today, source: `${fs.existsSync(path.join(choice.cwd, CONFIG)) ? `today's ${CONFIG}` : "today's defaults (this checkout has no rigour.yml)"} (${why})` });
    if (choice.file) return { config: choice.today, source: `today's ${choice.file.split(path.sep).join('/')} (-c)` };
    if (choice.now) return today('--config-now');
    let text: string;
    try {
        text = fs.readFileSync(path.join(worktree, CONFIG), 'utf8');
    } catch {
        return today('the commit had none');
    }
    const parsed = parseConfig(text);
    if (typeof parsed === 'string') return today(`the commit's does not parse: ${parsed}`);
    return { config: parsed, source: `the commit's ${CONFIG}` };
}

/** The settings in a rigour.yml's text, or why they are not settings. */
function parseConfig(text: string): Config | string {
    try {
        const parsed = ConfigSchema.safeParse(yaml.parse(text) ?? {});
        return parsed.success ? parsed.data : parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/** A time as written in the ledger; one with no zone is UTC, as GitHub writes them (JavaScript would read it as local time). */
function utc(at: string): number {
    const zoned = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(at.trim()) ? `${at.trim()}Z` : at;
    return Date.parse(zoned);
}

/** The moment the round's reviewer knows nothing from: the review's time, else the commit's. */
export async function replayMoment(worktree: string, reviewedAt: string | undefined, exec: Exec): Promise<{ at: string; why: string }> {
    const reviewed = reviewedAt ? utc(reviewedAt) : NaN;
    if (!Number.isNaN(reviewed)) return { at: new Date(reviewed).toISOString(), why: 'reviewed_at' };
    const committed = (await exec('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: worktree, timeoutMs: 60_000 })).stdout.trim();
    const at = Number.isNaN(Date.parse(committed)) ? new Date(0).toISOString() : new Date(Date.parse(committed)).toISOString();
    return { at, why: reviewedAt ? `the commit's time: reviewed_at "${reviewedAt}" is not a time` : "the commit's time: the round has no reviewed_at" };
}

/** RIGOUR_REVIEW_LESSONS, when set: a backtest reads the worktree's own lessons instead, and says so. */
export function lessonsEnvIgnored(): string | undefined {
    const set = process.env.RIGOUR_REVIEW_LESSONS?.trim();
    return set ? `RIGOUR_REVIEW_LESSONS (${set}) is set and ignored: the backtest reads only the lessons at the commit, as of the review` : undefined;
}

/** The round's report lines for what it ran with: the plain line first, then each thing that was not the commit's. */
export function formatReplay(replay: Replay | undefined): string[] {
    if (!replay) return [];
    const l = replay.lessons;
    const lessons = l ? `lessons as of ${replay.asOf}: ${l.served} served, ${l.later} learned later left out, ${l.untimed} with no timestamp left out${l.teamLeftOut ? `, ${l.teamLeftOut} team decision(s) made later left out` : ''}` : `lessons as of ${replay.asOf}`;
    const lines = [`  config: ${replay.config}`, `  dependencies: ${describeDependencies(replay.dependencies)}`, `  ${lessons}`];
    if (replay.lessonsEnvIgnored) lines.push(`  ${replay.lessonsEnvIgnored}`);
    for (const judge of replay.judgesNotIsolated ?? []) lines.push(`  ${judge}`);
    return lines;
}

/** For a report over many rounds (`--last`): the settings each used, then only what was not the commit's. */
export function replayWarnings(replay: Replay | undefined): string[] {
    if (!replay) return [];
    const lines: string[] = [];
    if (replay.dependencies.used === 'today') lines.push(`dependencies: ${describeDependencies(replay.dependencies)}`);
    lines.push(`config: ${replay.config}`);
    if (replay.lessons?.untimed) lines.push(`${replay.lessons.untimed} lesson(s) with no timestamp left out`);
    if (replay.lessonsEnvIgnored) lines.push(replay.lessonsEnvIgnored);
    lines.push(...(replay.judgesNotIsolated ?? []));
    return lines;
}

/**
 * The judges whose review record says they also read the machine's own memory or settings (adapters.ts, outsideRepo),
 * and those the backtest could not give a home of their own. What a judge read inside the backtest's own judge home
 * (`ownHome`: only the model settings it was given) is not memory.
 */
export function notIsolated(record: Pick<ReviewRecord, 'judges'> | undefined, ownHome: string, unhoused: Array<{ judge: string; why: string }> = []): string[] {
    const read = (record?.judges ?? []).filter(j => j.outside_repo && !j.outside_repo.includes(ownHome)).map(j => `${j.reviewer} judge memory not isolated (${j.outside_repo})`);
    const ran = new Set((record?.judges ?? []).map(j => j.reviewer));
    return [...read, ...unhoused.filter(u => ran.has(u.judge)).map(u => `${u.judge} judge memory not isolated (${u.why})`)];
}
