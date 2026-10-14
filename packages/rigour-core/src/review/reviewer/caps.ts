/**
 * The spending caps every model run Rigour starts is checked against, in one place: the reviewer's judges, retries,
 * cross-examinations and follow-ups, the rule writer, and the deep review's cloud model.
 */
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

/** What rigour.yml's schema gives review.reviewer.max_usd_per_day when the file is silent (types/index.ts). */
const DEFAULT_USD_PER_DAY = 10;

/**
 * Where the daily cost cap comes from: rigour.yml, Rigour's default (rigour.yml is silent), or the person's own lower
 * cap. `default` and `rigour.yml` are told apart only with the repository's rigour.yml at hand (capOrigin).
 */
export type UsdPerDayOrigin = 'rigour.yml' | 'default' | 'user';

interface Caps { max_runs_per_day?: number; max_usd_per_day?: number; max_usd_per_review?: number; usd_per_day_from?: 'team' | 'user'; usd_per_day_origin?: UsdPerDayOrigin }

/**
 * Why the caps leave no room for `planned` more runs today, or nothing when they do. `review` is what the current review
 * (or one rule-writing or deep run) has spent so far, against `max_usd_per_review`.
 */
export function overBudget(spent: { runs: number; usd: number }, caps: Caps, planned: number, review = 0): string | undefined {
    if (caps.max_usd_per_review !== undefined && review >= caps.max_usd_per_review) return `this review's cost cap is reached: $${review.toFixed(2)} of $${caps.max_usd_per_review.toFixed(2)} spent by this review (review.reviewer.max_usd_per_review)`;
    if (caps.max_runs_per_day !== undefined && spent.runs + planned > caps.max_runs_per_day) return `the daily run cap is reached: ${spent.runs} of ${caps.max_runs_per_day} agent runs used today in this repository, and this needs ${planned} more (review.reviewer.max_runs_per_day)`;
    if (caps.max_usd_per_day !== undefined && spent.usd >= caps.max_usd_per_day) return `the daily cost cap is reached: $${spent.usd.toFixed(2)} of $${caps.max_usd_per_day.toFixed(2)} reported today in this repository (review.reviewer.max_usd_per_day). ${usdPerDayNote(caps.max_usd_per_day, caps.usd_per_day_origin ?? (caps.usd_per_day_from === 'user' ? 'user' : undefined))}`;
    return undefined;
}

/** What the daily cost cap is, where it comes from, and how to change it (a person can only lower it). */
export function usdPerDayNote(cap: number, origin: UsdPerDayOrigin | undefined): string {
    const usd = `$${cap.toFixed(2)}`;
    const change = 'To change it, set review.reviewer.max_usd_per_day in rigour.yml; your own reviewer.max_usd_per_day (~/.rigour/settings.json) can only lower it.';
    if (origin === 'user') return `The cap is ${usd}, your own reviewer.max_usd_per_day (~/.rigour/settings.json), lower than rigour.yml's. Raise or remove yours to use rigour.yml's; review.reviewer.max_usd_per_day in rigour.yml is the most it can be.`;
    if (origin === 'default') return `The cap is ${usd}, Rigour's default: rigour.yml does not set review.reviewer.max_usd_per_day. ${change}`;
    if (origin === 'rigour.yml') return `The cap is ${usd}, set by review.reviewer.max_usd_per_day in rigour.yml. ${change}`;
    return `The cap is ${usd}: review.reviewer.max_usd_per_day in rigour.yml, $${DEFAULT_USD_PER_DAY} by default when it does not set it. ${change}`;
}

/**
 * The caps with where the daily cost cap comes from, read from the repository's rigour.yml: a cap the person lowered is
 * theirs, a key rigour.yml sets is rigour.yml's, and a silent rigour.yml is the default. An unreadable file says neither.
 */
export function capOrigin<T extends Caps>(caps: T, repoRoot: string): T {
    if (caps.max_usd_per_day === undefined) return caps;
    if (caps.usd_per_day_from === 'user') return { ...caps, usd_per_day_origin: 'user' };
    const sets = rigourYmlSetsUsdPerDay(path.join(repoRoot, 'rigour.yml'));
    if (sets) return { ...caps, usd_per_day_origin: 'rigour.yml' };
    // A silent rigour.yml with a cap other than the default: the settings came from elsewhere, so neither is claimed.
    return sets === false && caps.max_usd_per_day === DEFAULT_USD_PER_DAY ? { ...caps, usd_per_day_origin: 'default' } : caps;
}

/** Whether the rigour.yml at `file` sets review.reviewer.max_usd_per_day (none is a silent one), or undefined when it cannot be read. */
function rigourYmlSetsUsdPerDay(file: string): boolean | undefined {
    if (!fs.existsSync(file)) return false;
    try {
        return yaml.parse(fs.readFileSync(file, 'utf8'))?.review?.reviewer?.max_usd_per_day !== undefined;
    } catch {
        return undefined;
    }
}
