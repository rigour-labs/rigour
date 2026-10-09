/**
 * Anonymous, opt-in usage telemetry: how Rigour is used and where it is wrong,
 * so the next release fixes what people actually hit. Every field is listed in
 * TELEMETRY.md.
 *
 * Never sent: code, file or repository names, paths, git remotes, finding
 * text, emails, keys, IP addresses (Mixpanel is told not to record them). The
 * only identity is a random install id. Nothing is sent unless the person said
 * yes, a token is built in (release builds only), and neither DO_NOT_TRACK nor
 * RIGOUR_TELEMETRY=0 is set. CI never sends unless RIGOUR_TELEMETRY=1. A send
 * that fails or is slow is dropped: telemetry never fails or slows a command.
 *
 * Two shapes: an event per CLI command or review (`trackUsage`), and, for the
 * hot paths an agent drives on every edit (hooks, MCP tools), local counters
 * (`countUsage`, no network) sent as one `daily_usage` event a day.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rigourHome } from '../utils/user-state.js';
import { MIXPANEL_TOKEN } from './token.js';

const ENDPOINT = 'https://api.mixpanel.com/track?ip=0';
const TIMEOUT_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init?: any) => Promise<unknown>;

export interface TelemetryState {
    /** undefined until the person has been asked. */
    enabled?: boolean;
    installId: string;
    /** When the person was first asked (ms): how old the install is, bucketed. Absent in files written before it was kept. */
    firstAt?: number;
}

export interface TelemetryDeps {
    env?: Env;
    home?: string;
    fetch?: Fetch;
    version?: string;
    now?: number;
    /** The agent a hook ran for, when the hook knows (its own tool name): wins over the environment. */
    agent?: string;
    /** More of the daily event, read only when it is sent (learning-usage.ts): the learning loop of the repository the command ran in. */
    daily?: () => Record<string, unknown>;
}

/** The agent hosts telemetry names, and nothing else: anything unknown is `other`, no agent is `none`. */
export type AgentHost = 'claude-code' | 'cursor' | 'cline' | 'windsurf' | 'codex' | 'other' | 'none';

const HOOK_TOOLS: Record<string, AgentHost> = { claude: 'claude-code', 'claude-code': 'claude-code', cursor: 'cursor', cline: 'cline', windsurf: 'windsurf', codex: 'codex' };

/**
 * Which agent Rigour ran under: the hook's own tool name when it is one of the known; else the variable each sets in
 * the processes it starts (CLAUDECODE=1 for Claude Code, CURSOR_TRACE_ID for Cursor's terminal, CODEX_SANDBOX for
 * Codex); else `other` for a hint naming an agent not on the list, `none` without one. Cline and Windsurf are known
 * only from their hooks.
 */
function agentHost(env: Env, hint?: string): AgentHost {
    const known = hint ? HOOK_TOOLS[hint.toLowerCase()] : undefined;
    if (known) return known;
    if (env.CLAUDECODE === '1') return 'claude-code';
    if (env.CURSOR_TRACE_ID) return 'cursor';
    if (env.CODEX_SANDBOX) return 'codex';
    return hint ? 'other' : 'none';
}

const WEEK_MS = 7 * DAY_MS;

/** When telemetry.json was first written, for a file from before `firstAt` was kept: its creation time, else its last write. */
function firstWritten(home: string): number | undefined {
    try {
        const stat = fs.statSync(file(home, 'telemetry.json'));
        return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    } catch {
        return undefined;
    }
}

/** How long ago the person was first asked, bucketed: 0, 1, 2-4, 5-12 or 13+ weeks; undefined before they were. */
function installAgeWeeks(home: string, now: number): string | undefined {
    const first = readTelemetryState(home).firstAt ?? firstWritten(home);
    if (first === undefined) return undefined;
    const weeks = Math.floor(Math.max(0, now - first) / WEEK_MS);
    return weeks === 0 ? '0' : weeks === 1 ? '1' : weeks <= 4 ? '2-4' : weeks <= 12 ? '5-12' : '13+';
}

export function telemetryToken(env: Env = process.env): string {
    return env.RIGOUR_MIXPANEL_TOKEN?.trim() || MIXPANEL_TOKEN;
}

function file(home: string, name: string): string {
    return path.join(home, '.rigour', name);
}

export function readTelemetryState(home = rigourHome()): TelemetryState {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(home, 'telemetry.json'), 'utf8'));
        if (typeof parsed?.installId === 'string') return { installId: parsed.installId, enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined, ...(typeof parsed.firstAt === 'number' ? { firstAt: parsed.firstAt } : {}) };
    } catch {
        // Not asked yet.
    }
    return { installId: crypto.randomUUID() };
}

export function setTelemetryEnabled(enabled: boolean, home = rigourHome()): TelemetryState {
    const current = readTelemetryState(home);
    const state = { ...current, enabled, firstAt: current.firstAt ?? firstWritten(home) ?? Date.now() };
    writeJson(file(home, 'telemetry.json'), state);
    return state;
}

/** CI systems by the variable each always sets; Jenkins, Azure Pipelines and TeamCity do not set CI. */
const CI_MARKERS = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION'];

function isCi(env: Env): boolean {
    return CI_MARKERS.some(name => !!env[name]);
}

/** Opted out by the environment, whatever the stored answer. */
/** The cross-tool opt-out (consoledonottrack.com): any value but "0" means no telemetry and no update check. */
export function doNotTrack(env: Env = process.env): boolean {
    return !!env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0';
}

function vetoed(env: Env): boolean {
    return doNotTrack(env) || env.RIGOUR_TELEMETRY === '0' || !telemetryToken(env);
}

export function isTelemetryEnabled(deps: TelemetryDeps = {}): boolean {
    const env = deps.env ?? process.env;
    if (vetoed(env)) return false;
    if (env.RIGOUR_TELEMETRY === '1') return true;
    if (isCi(env)) return false;
    return readTelemetryState(deps.home).enabled === true;
}

/** Ask only once, only a person at a terminal, only when sending would be possible at all. */
export function shouldAskTelemetry(isTty: boolean, deps: TelemetryDeps = {}): boolean {
    const env = deps.env ?? process.env;
    return isTty && !isCi(env) && !vetoed(env) && env.RIGOUR_TELEMETRY === undefined && readTelemetryState(deps.home).enabled === undefined;
}

export async function trackUsage(event: string, properties: Record<string, unknown>, deps: TelemetryDeps = {}): Promise<void> {
    if (!isTelemetryEnabled(deps)) return;
    const env = deps.env ?? process.env;
    const body = [{
        event,
        properties: {
            token: telemetryToken(env),
            distinct_id: readTelemetryState(deps.home).installId,
            time: Math.floor((deps.now ?? Date.now()) / 1000),
            $insert_id: crypto.randomUUID(),
            version: deps.version,
            os: process.platform,
            node_major: Number(process.versions.node.split('.')[0]),
            ci: isCi(env),
            agent_host: agentHost(env, deps.agent),
            install_age_weeks: installAgeWeeks(deps.home ?? rigourHome(), deps.now ?? Date.now()),
            ...properties,
        },
    }];
    try {
        await (deps.fetch ?? (fetch as unknown as Fetch))(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/plain' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        // Dropped: telemetry never affects the command.
    }
}

interface Counters {
    since: number;
    counts: Record<string, number>;
}

/** Count something an agent does on a hot path (a hook check, an MCP tool call). Local only; no network. */
export function countUsage(name: string, by = 1, deps: TelemetryDeps = {}): void {
    if (!isTelemetryEnabled(deps)) return;
    try {
        const home = deps.home ?? rigourHome();
        const counters = readCounters(home, deps.now ?? Date.now());
        counters.counts[name] = (counters.counts[name] ?? 0) + by;
        // What each agent drives: one count per agent host, beside the thing counted.
        const host = `agent_host:${agentHost(deps.env ?? process.env, deps.agent)}`;
        counters.counts[host] = (counters.counts[host] ?? 0) + by;
        writeJson(file(home, 'telemetry-counters.json'), counters);
    } catch {
        // Counting never affects the agent.
    }
}

/** Send the day's counters as one `daily_usage` event once they are a day old, then start a new day. */
export async function flushDailyUsage(deps: TelemetryDeps = {}): Promise<boolean> {
    if (!isTelemetryEnabled(deps)) return false;
    const home = deps.home ?? rigourHome();
    const now = deps.now ?? Date.now();
    const counters = readCounters(home, now);
    // The day starts the first time anything could be sent, so a day with no counts still ends.
    if (deps.daily && !fs.existsSync(file(home, 'telemetry-counters.json'))) writeJson(file(home, 'telemetry-counters.json'), counters);
    if (now - counters.since < DAY_MS || (Object.keys(counters.counts).length === 0 && !deps.daily)) return false;
    writeJson(file(home, 'telemetry-counters.json'), { since: now, counts: {} });
    let daily: Record<string, unknown> = {};
    try {
        daily = deps.daily?.() ?? {};
    } catch {
        // What the learning loop did is extra: the day's counts go out without it.
    }
    await trackUsage('daily_usage', { ...counters.counts, ...daily }, deps);
    return true;
}

function readCounters(home: string, now: number): Counters {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(home, 'telemetry-counters.json'), 'utf8'));
        if (typeof parsed?.since === 'number' && parsed.counts && typeof parsed.counts === 'object') return parsed;
    } catch {
        // First count.
    }
    return { since: now, counts: {} };
}

function writeJson(target: string, value: unknown): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n');
}

/** A duration as a coarse bucket, so timing never identifies a run. */
/** A model run's cost as a coarse bucket: never the amount. */
export function costBucket(usd: number | undefined): string | undefined {
    if (typeof usd !== 'number') return undefined;
    return usd < 0.1 ? '<$0.10' : usd < 0.5 ? '$0.10-0.50' : usd < 2 ? '$0.50-2' : '>$2';
}

export function durationBucket(ms: number): string {
    if (ms < 1000) return '<1s';
    if (ms < 5000) return '1-5s';
    if (ms < 30000) return '5-30s';
    if (ms < 120000) return '30s-2m';
    return '>2m';
}
