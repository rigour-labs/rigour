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
    /** Today's settings, as the command loaded them. */
    today: Config;
    /** Keep today's settings for every round (`--config-now`). */
    now?: boolean;
    /** The settings file, relative to the repository (rigour.yml, or what -c names). */
    file?: string;
}

/** The settings the round reviews with: the commit's own file, the defaults when it has none, or today's when asked. */
export function configAtCommit(worktree: string, choice: ConfigChoice): { config: Config; source: string } {
    const file = (choice.file ?? 'rigour.yml').split(path.sep).join('/');
    if (choice.now) return { config: choice.today, source: `today's ${file} (--config-now)` };
    if (path.isAbsolute(file) || file.startsWith('../')) return { config: choice.today, source: `today's ${file}, not the commit's (it is outside the repository)` };
    let text: string;
    try {
        text = fs.readFileSync(path.join(worktree, file), 'utf8');
    } catch {
        return { config: ConfigSchema.parse({}), source: `the defaults (the commit has no ${file})` };
    }
    const parsed = parseConfig(text);
    if (typeof parsed === 'string') return { config: choice.today, source: `today's ${file}, not the commit's (the commit's does not parse: ${parsed})` };
    return { config: parsed, source: `the commit's ${file}` };
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

/** The moment the round's reviewer knows nothing after: the review's time, else the commit's. */
export async function replayMoment(worktree: string, reviewedAt: string | undefined, exec: Exec): Promise<{ at: string; why: string }> {
    if (reviewedAt && !Number.isNaN(Date.parse(reviewedAt))) return { at: new Date(Date.parse(reviewedAt)).toISOString(), why: 'reviewed_at' };
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
    for (const judge of replay.judgesNotIsolated ?? []) lines.push(`  judge memory not isolated: ${judge}`);
    return lines;
}

/** Only what was not the commit's, for a report over many rounds (`--last`). */
export function replayWarnings(replay: Replay | undefined): string[] {
    if (!replay) return [];
    const lines: string[] = [];
    if (replay.dependencies.used === 'today') lines.push(`dependencies: ${describeDependencies(replay.dependencies)}`);
    if (replay.config.startsWith("today's")) lines.push(`config: ${replay.config}`);
    if (replay.lessons?.untimed) lines.push(`${replay.lessons.untimed} lesson(s) with no timestamp left out`);
    if (replay.lessonsEnvIgnored) lines.push(replay.lessonsEnvIgnored);
    for (const judge of replay.judgesNotIsolated ?? []) lines.push(`judge memory not isolated: ${judge}`);
    return lines;
}

/** The judges whose review record says they also read the machine's own memory or settings (adapters.ts, outsideRepo). */
export function notIsolated(record: Pick<ReviewRecord, 'judges'> | undefined): string[] {
    return (record?.judges ?? []).filter(j => j.outside_repo).map(j => `${j.reviewer}: ${j.outside_repo}`);
}
