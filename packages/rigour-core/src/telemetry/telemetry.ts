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
}

export interface TelemetryDeps {
    env?: Env;
    home?: string;
    fetch?: Fetch;
    version?: string;
    now?: number;
}

export function telemetryToken(env: Env = process.env): string {
    return env.RIGOUR_MIXPANEL_TOKEN?.trim() || MIXPANEL_TOKEN;
}

function file(home: string, name: string): string {
    return path.join(home, '.rigour', name);
}

export function readTelemetryState(home = os.homedir()): TelemetryState {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(home, 'telemetry.json'), 'utf8'));
        if (typeof parsed?.installId === 'string') return { installId: parsed.installId, enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined };
    } catch {
        // Not asked yet.
    }
    return { installId: crypto.randomUUID() };
}

export function setTelemetryEnabled(enabled: boolean, home = os.homedir()): TelemetryState {
    const state = { ...readTelemetryState(home), enabled };
    writeJson(file(home, 'telemetry.json'), state);
    return state;
}

function isCi(env: Env): boolean {
    return !!(env.CI || env.GITHUB_ACTIONS || env.BUILDKITE || env.GITLAB_CI || env.CIRCLECI);
}

/** Opted out by the environment, whatever the stored answer. */
function vetoed(env: Env): boolean {
    return (!!env.DO_NOT_TRACK && env.DO_NOT_TRACK !== '0') || env.RIGOUR_TELEMETRY === '0' || !telemetryToken(env);
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
        const home = deps.home ?? os.homedir();
        const counters = readCounters(home, deps.now ?? Date.now());
        counters.counts[name] = (counters.counts[name] ?? 0) + by;
        writeJson(file(home, 'telemetry-counters.json'), counters);
    } catch {
        // Counting never affects the agent.
    }
}

/** Send the day's counters as one `daily_usage` event once they are a day old, then start a new day. */
export async function flushDailyUsage(deps: TelemetryDeps = {}): Promise<boolean> {
    if (!isTelemetryEnabled(deps)) return false;
    const home = deps.home ?? os.homedir();
    const now = deps.now ?? Date.now();
    const counters = readCounters(home, now);
    if (now - counters.since < DAY_MS || Object.keys(counters.counts).length === 0) return false;
    writeJson(file(home, 'telemetry-counters.json'), { since: now, counts: {} });
    await trackUsage('daily_usage', { ...counters.counts }, deps);
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
export function durationBucket(ms: number): string {
    if (ms < 1000) return '<1s';
    if (ms < 5000) return '1-5s';
    if (ms < 30000) return '5-30s';
    if (ms < 120000) return '30s-2m';
    return '>2m';
}
