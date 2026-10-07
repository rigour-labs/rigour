/**
 * Studio's "Reviewer": the model reviewer as a person controls it. What it last decided on this
 * branch (which mode ran against what was asked, the findings to fix, the disputed ones and the
 * cost), every setting with where its value comes from (this run's defaults, the person, the
 * team), and which agent CLIs this machine has, since those bound the judges. A person can change
 * their own settings and dismiss a finding here. A team setting is written to rigour.yml in the
 * working tree, comments and layout kept, and never committed: team policy still reaches everyone
 * through a reviewed commit, and Studio shows the diff to commit.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import {
    ConfigSchema, dismissReviewerFinding, loadSettings, resolveReviewer, reviewerAvailability, reviewStatus, saveUserReviewer,
    type ReviewStatus, type UserReviewerPatch,
} from '@rigour-labs/core';
import { loadConfig } from './review-config.js';

const TEAM_KEYS = ['enabled', 'mode', 'panel', 'mode_required', 'judges', 'escalate', 'reviewers', 'on_push', 'panel_max_items', 'dismissals'] as const;

export interface StudioReviewer {
    branch: string;
    status: ReviewStatus | null;
    effective: ReturnType<typeof resolveReviewer>;
    team: Record<string, unknown>;
    /** Whether the team's settings come from a rigour.yml, or are Rigour's defaults. */
    teamFile: boolean;
    user: Record<string, unknown>;
    available: Awaited<ReturnType<typeof reviewerAvailability>>;
}

export async function loadStudioReviewer(cwd: string): Promise<StudioReviewer> {
    const config = await loadConfig(cwd, {});
    const team = config.review?.reviewer;
    const branch = currentBranch(cwd);
    return {
        branch,
        status: (await reviewStatus(cwd, branch)) ?? null,
        effective: resolveReviewer(config),
        team: team ? Object.fromEntries(TEAM_KEYS.map(key => [key, team[key]])) : {},
        teamFile: fs.existsSync(path.join(cwd, 'rigour.yml')),
        user: { ...(loadSettings().reviewer ?? {}) },
        available: await availability(cwd),
    };
}

const AVAILABILITY_MS = 5 * 60_000;
let availabilityCache: { at: number; cwd: string; value: Promise<StudioReviewer['available']> } | undefined;

/** Which agent CLIs this machine has: asked once every few minutes, not on every read (each asks every CLI for its version). */
function availability(cwd: string): Promise<StudioReviewer['available']> {
    if (!availabilityCache || availabilityCache.cwd !== cwd || Date.now() - availabilityCache.at > AVAILABILITY_MS) availabilityCache = { at: Date.now(), cwd, value: reviewerAvailability(cwd) };
    return availabilityCache.value;
}

function currentBranch(cwd: string): string {
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'HEAD';
    } catch {
        return 'HEAD';
    }
}

/** A person's own settings, changed from Studio; refused when it is not a setting a person may change. */
export async function saveStudioReviewer(cwd: string, body: unknown): Promise<StudioReviewer> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('send the settings to change as an object');
    saveUserReviewer(body as UserReviewerPatch);
    return loadStudioReviewer(cwd);
}

/** "Not a bug" on a reviewer finding, from Studio: the same record as `rigour dismiss <id>`. */
export async function dismissFromStudio(cwd: string, body: unknown): Promise<{ dismissed: string }> {
    const { id, reason } = (body ?? {}) as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string' || !/^[0-9a-f]{10}$/.test(id)) throw new Error('a reviewer finding id (10 hex characters) is required');
    if (typeof reason !== 'string' || reason.trim().length < 5) throw new Error('say why it is not a bug, in a few words');
    const { item, error } = await dismissReviewerFinding(cwd, id, reason.trim(), resolveReviewer(await loadConfig(cwd, {})).dismissals);
    if (error) throw new Error(error);
    return { dismissed: item!.issue };
}

const TEAM_WRITABLE = new Set<string>(TEAM_KEYS);

/**
 * A team setting from Studio: only review.reviewer keys, `null` removes one (Rigour's default
 * again). The whole file must still be a valid rigour.yml before it is written. A missing file is
 * created only when asked (`create: true`), since that turns a personal install into the team's.
 */
export async function saveTeamReviewer(cwd: string, body: unknown): Promise<StudioReviewer & { diff: string }> {
    const { patch, create } = (body ?? {}) as { patch?: Record<string, unknown>; create?: boolean };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('send the team settings to change as an object');
    const unknown = Object.keys(patch).find(key => !TEAM_WRITABLE.has(key));
    if (unknown) throw new Error(`not a team reviewer setting: ${unknown}`);
    const file = path.join(cwd, 'rigour.yml');
    const exists = fs.existsSync(file);
    if (exists && fs.lstatSync(file).isSymbolicLink()) throw new Error('rigour.yml is a link: edit the file it points to directly');
    if (!exists && create !== true) throw new Error('there is no rigour.yml: creating one makes this the team\'s setup, so confirm it (create: true)');
    const doc = exists ? YAML.parseDocument(fs.readFileSync(file, 'utf8')) : new YAML.Document({});
    if (doc.errors.length) throw new Error(`rigour.yml does not parse: ${doc.errors[0].message}`);
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) doc.deleteIn(['review', 'reviewer', key]);
        else doc.setIn(['review', 'reviewer', key], value);
    }
    const parsed = ConfigSchema.safeParse(doc.toJS());
    if (!parsed.success) throw new Error(`that would not be a valid rigour.yml: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    fs.writeFileSync(file, String(doc));
    return { ...(await loadStudioReviewer(cwd)), diff: diffOf(cwd, exists) };
}

/** What the person will commit: git's diff of rigour.yml, or the whole new file. */
function diffOf(cwd: string, existed: boolean): string {
    if (!existed) return fs.readFileSync(path.join(cwd, 'rigour.yml'), 'utf8').split('\n').filter(Boolean).map(line => `+${line}`).join('\n');
    try {
        return execFileSync('git', ['diff', '--no-color', '--unified=1', '--', 'rigour.yml'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .split('\n').filter(line => /^[+-](?![+-])/.test(line) || line.startsWith('@@')).join('\n');
    } catch {
        return '';
    }
}
