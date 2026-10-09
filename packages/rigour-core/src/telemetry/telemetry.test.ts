import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUsage, durationBucket, flushDailyUsage, isTelemetryEnabled, readTelemetryState, setTelemetryEnabled, shouldAskTelemetry, trackUsage } from './telemetry.js';
import { recordOutcome } from '../review/check-outcomes.js';
import { recordPrCatches } from '../review/learning-events.js';

let home: string;
const env = { RIGOUR_MIXPANEL_TOKEN: 'tok' };
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('telemetry consent', () => {
    it('sends nothing until the person says yes, and the environment always wins', () => {
        expect(isTelemetryEnabled({ env, home })).toBe(false);
        expect(shouldAskTelemetry(true, { env, home })).toBe(true);
        setTelemetryEnabled(true, home);
        expect(isTelemetryEnabled({ env, home })).toBe(true);
        expect(shouldAskTelemetry(true, { env, home })).toBe(false); // asked once
        expect(isTelemetryEnabled({ env: { ...env, DO_NOT_TRACK: '1' }, home })).toBe(false);
        expect(isTelemetryEnabled({ env: { ...env, RIGOUR_TELEMETRY: '0' }, home })).toBe(false);
        expect(isTelemetryEnabled({ env: { ...env, CI: 'true' }, home })).toBe(false);
        expect(isTelemetryEnabled({ env: {}, home })).toBe(false); // a build without a token never sends
    });

    it('never asks in CI or without a terminal, and keeps one random install id', () => {
        expect(shouldAskTelemetry(false, { env, home })).toBe(false);
        expect(shouldAskTelemetry(true, { env: { ...env, GITHUB_ACTIONS: 'true' }, home })).toBe(false);
        setTelemetryEnabled(true, home);
        for (const ci of ['JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION']) {
            expect(isTelemetryEnabled({ env: { ...env, [ci]: 'x' }, home })).toBe(false); // a build agent's stored yes is not a CI opt-in
            expect(isTelemetryEnabled({ env: { ...env, [ci]: 'x', RIGOUR_TELEMETRY: '1' }, home })).toBe(true);
        }
        const first = setTelemetryEnabled(false, home).installId;
        expect(readTelemetryState(home).installId).toBe(first);
        expect(first).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe('telemetry sending', () => {
    it('sends one event with the install id and no IP, and swallows a failing network', async () => {
        setTelemetryEnabled(true, home);
        const fetch = vi.fn().mockResolvedValue({ ok: true });
        await trackUsage('review_completed', { status: 'PASS', findings_by_gate: { 'semantic-bugs': 1 } }, { env, home, fetch, version: '6.5.0' });
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('https://api.mixpanel.com/track?ip=0');
        const [event] = JSON.parse(init.body);
        expect(event.event).toBe('review_completed');
        expect(event.properties).toMatchObject({ token: 'tok', distinct_id: readTelemetryState(home).installId, version: '6.5.0', status: 'PASS' });
        expect(JSON.stringify(event)).not.toContain(home);

        await expect(trackUsage('x', {}, { env, home, fetch: vi.fn().mockRejectedValue(new Error('offline')) })).resolves.toBeUndefined();
    });

    it('counts hot-path activity locally and sends it as one daily event', async () => {
        setTelemetryEnabled(true, home);
        const fetch = vi.fn().mockResolvedValue({ ok: true });
        const day = 24 * 60 * 60 * 1000;
        countUsage('hook_check', 1, { env, home, now: 0 });
        countUsage('hook_check', 1, { env, home, now: 1000 });
        countUsage('mcp:rigour_review', 1, { env, home, now: 2000 });
        expect(await flushDailyUsage({ env, home, fetch, now: 5000 })).toBe(false); // not a day yet
        expect(await flushDailyUsage({ env, home, fetch, now: day + 1 })).toBe(true);
        const [event] = JSON.parse(fetch.mock.calls[0][1].body);
        expect(event).toMatchObject({ event: 'daily_usage', properties: { hook_check: 2, 'mcp:rigour_review': 1, 'agent_host:none': 3 } });
        expect(await flushDailyUsage({ env, home, fetch, now: 2 * day + 2 })).toBe(false); // counters reset
    });

    it('buckets durations so timing never identifies a run', () => {
        expect([500, 3000, 20000, 60000, 600000].map(durationBucket)).toEqual(['<1s', '1-5s', '5-30s', '30s-2m', '>2m']);
    });
});

describe('telemetry A: the agent host, the install age, and what happened to each check\'s findings', () => {
    const week = 7 * 24 * 60 * 60 * 1000;

    /** The properties one event carries, sent with these deps. */
    const sent = async (deps: { env?: Record<string, string>; agent?: string; now?: number }) => {
        const fetch = vi.fn().mockResolvedValue({ ok: true });
        await trackUsage('command_run', { command: 'review' }, { env: { ...env, ...deps.env }, home, fetch, ...(deps.agent ? { agent: deps.agent } : {}), ...(deps.now ? { now: deps.now } : {}) });
        return JSON.parse(fetch.mock.calls[0][1].body)[0].properties;
    };

    it('names the agent host from the hook, else the environment, as one of a fixed list', async () => {
        setTelemetryEnabled(true, home);
        const host = async (deps: { env?: Record<string, string>; agent?: string }) => (await sent(deps)).agent_host;
        expect(await host({ agent: 'claude' })).toBe('claude-code');
        expect(await host({ agent: 'windsurf' })).toBe('windsurf');
        expect(await host({ agent: 'cline' })).toBe('cline');
        expect(await host({ agent: 'some-new-agent' })).toBe('other');
        expect(await host({ agent: 'agent-7', env: { CLAUDECODE: '1' } })).toBe('claude-code'); // a custom agent id: the environment knows better
        expect(await host({ env: { CURSOR_TRACE_ID: 'x' } })).toBe('cursor');
        expect(await host({ env: { CODEX_SANDBOX: 'seatbelt' } })).toBe('codex');
        expect(await host({})).toBe('none');
    });

    it('buckets the install age from when the person was first asked, and keeps that moment', async () => {
        const first = setTelemetryEnabled(true, home).firstAt!;
        expect(setTelemetryEnabled(true, home).firstAt).toBe(first); // kept, never moved
        const ages = [];
        for (const w of [0, 1, 3, 8, 30]) ages.push((await sent({ now: first + w * week + 1 })).install_age_weeks);
        expect(ages).toEqual(['0', '1', '2-4', '5-12', '13+']);
    });

    it('counts a fixed, dismissed or pushed finding by its gate id only, and nothing at all with telemetry off', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-repo-'));
        const saved = { ...process.env };
        const counters = () => { try { return JSON.parse(fs.readFileSync(path.join(process.env.RIGOUR_HOME!, '.rigour', 'telemetry-counters.json'), 'utf8')).counts; } catch { return {}; } };
        try {
            fs.rmSync(path.join(process.env.RIGOUR_HOME!, '.rigour', 'telemetry-counters.json'), { force: true });
            recordOutcome(repo, 'semantic-bugs: Credential header follows redirects', 'fixed'); // telemetry off
            expect(counters()).toEqual({});
            Object.assign(process.env, { RIGOUR_MIXPANEL_TOKEN: 'tok', RIGOUR_TELEMETRY: '1' });
            recordOutcome(repo, 'semantic-bugs: Credential header follows redirects', 'fixed');
            recordOutcome(repo, 'unused-export: Unused export `x`', 'dismissed');
            recordOutcome(repo, 'acme-billing-guard: Billing totals must match', 'fixed'); // a team's own check, named in its config
            recordPrCatches(repo, [{ id: 'security-patterns', title: 'Hardcoded secret in src/secret.ts', details: 'd', severity: 'high', files: ['src/secret.ts'] } as never]);
            const counts = counters();
            expect(counts).toMatchObject({ 'finding_fixed:semantic-bugs': 1, 'finding_dismissed:unused-export': 1, 'finding_pushed:security-patterns': 1, 'finding_fixed:custom': 1 });
            expect(JSON.stringify(counts)).not.toMatch(/Credential|Unused export|secret\.ts|src\/|acme|Billing/);
        } finally {
            process.env = saved;
            fs.rmSync(repo, { recursive: true, force: true });
        }
    });
});

