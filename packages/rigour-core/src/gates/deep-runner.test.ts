import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { defaultExec } from '../review/reviewer/exec.js';
import { VerdictStore } from '../review/reviewer/store.js';
import { runDeepAnalysis } from './deep-runner.js';

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-runner-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe("the deep review's cloud model and the spending caps", () => {
    it('does not start past a daily cap, says which, and is skipped rather than failed', async () => {
        const config = ConfigSchema.parse({ version: 1, review: { reviewer: { max_usd_per_day: 1 } } });
        (await VerdictStore.open(repo, defaultExec))!.addSpend(1, 1.25); // the reviewer spent the day's dollars already
        // A key and a cloud provider: a paid run. Nothing is called; the cap decides first.
        const result = await runDeepAnalysis(config, { cwd: repo, ignore: [] }, { enabled: true, apiKey: 'not-a-real-key', provider: 'anthropic' });
        expect(result.summary).toBe('SKIP');
        expect(result.failures).toEqual([]);
        expect(result.stats.skipped).toBe('the cloud model did not run: the daily cost cap is reached: $1.25 of $1.00 reported today in this repository (review.reviewer.max_usd_per_day)');
    });
});
