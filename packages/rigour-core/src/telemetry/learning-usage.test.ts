import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { learningUsage } from './learning-usage.js';
import { flushDailyUsage, setTelemetryEnabled } from './telemetry.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-usage-')); });
afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

const record = (pr: number, fix: boolean) => ({ pr, mergeSha: `s${pr}`, mergedAt: '2026-09-01T00:00:00Z', branch: `b${pr}`, author: 'a', files: ['src/a.ts'], ci: 'success', followUps: fix ? [{ sha: 'f', at: '', subject: 'fix: x', files: ['src/a.ts'], fix: true }] : [], windowEnd: '', settled: true, checkedAt: '' });
const outcomes = (n: number) => {
    fs.mkdirSync(path.join(cwd, '.rigour'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.rigour', 'outcomes.json'), JSON.stringify({ version: 1, outcomes: Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, record(i + 1, i < 3)])) }));
};

describe('what the learning loop did, for opt-in telemetry', () => {
    it('says each switch\'s state and which layer set it, team or personal', () => {
        const usage = learningUsage(cwd, ConfigSchema.parse({ version: 1, review: { goal: 'required' } }));
        expect(usage).toMatchObject({ switch_goal: 'required', switch_goal_set_by: 'team', switch_outcomes: 'off', switch_orchestrator: 'off' });
        expect(usage).not.toHaveProperty('outcomes_merged'); // no records: nothing about outcomes
    });

    it('reads the outcome numbers as they are: counts, and a rate only from ten records', () => {
        outcomes(4);
        const few = learningUsage(cwd, ConfigSchema.parse({ version: 1 }));
        expect(few).toMatchObject({ outcomes_settled: 4, outcomes_fixed_later_count: 3, outcomes_fixed_later_of: 4 });
        expect(few).not.toHaveProperty('outcomes_fixed_later_rate');
        outcomes(10);
        expect(learningUsage(cwd, ConfigSchema.parse({ version: 1 }))).toMatchObject({ outcomes_fixed_later_count: 3, outcomes_fixed_later_of: 10, outcomes_fixed_later_rate: 0.3 });
    });

    it('goes out with the day\'s counts once a day, even with none, and a failing read never stops it', async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-home-'));
        try {
            setTelemetryEnabled(true, home);
            const env = { RIGOUR_MIXPANEL_TOKEN: 'tok' };
            const day = 24 * 60 * 60 * 1000;
            const fetch = vi.fn().mockResolvedValue({ ok: true });
            expect(await flushDailyUsage({ env, home, fetch, now: 0, daily: () => ({ switch_goal: 'on' }) })).toBe(false); // the day starts
            expect(await flushDailyUsage({ env, home, fetch, now: day + 1, daily: () => ({ switch_goal: 'on' }) })).toBe(true);
            expect(JSON.parse(fetch.mock.calls[0][1].body)[0]).toMatchObject({ event: 'daily_usage', properties: { switch_goal: 'on' } });
            expect(await flushDailyUsage({ env, home, fetch, now: 2 * day + 2, daily: () => { throw new Error('unreadable'); } })).toBe(true);
            expect(JSON.parse(fetch.mock.calls[1][1].body)[0].event).toBe('daily_usage');
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});
