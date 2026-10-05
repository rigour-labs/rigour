import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countUsage, durationBucket, flushDailyUsage, isTelemetryEnabled, readTelemetryState, setTelemetryEnabled, shouldAskTelemetry, trackUsage } from './telemetry.js';

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
        expect(event).toMatchObject({ event: 'daily_usage', properties: { hook_check: 2, 'mcp:rigour_review': 1 } });
        expect(await flushDailyUsage({ env, home, fetch, now: 2 * day + 2 })).toBe(false); // counters reset
    });

    it('buckets durations so timing never identifies a run', () => {
        expect([500, 3000, 20000, 60000, 600000].map(durationBucket)).toEqual(['<1s', '1-5s', '5-30s', '30s-2m', '>2m']);
    });
});
