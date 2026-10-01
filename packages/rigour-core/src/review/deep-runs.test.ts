import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendDeepRun, readDeepRuns, summarizeDeepRuns } from './deep-runs.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-runs-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('deep runs', () => {
    it('records what each run spent and sums only what was reported', () => {
        appendDeepRun(dir, { enabled: true, status: 'ok', tier: 'cloud', cost_usd: 0.25, input_tokens: 1000, output_tokens: 100,
            router: { functions: 10, routed: 3, files_skipped: 2, already_reviewed: 1 }, tool_calls: 7, findings_count: 2 });
        appendDeepRun(dir, { enabled: true, status: 'partial', tier: 'cloud', input_tokens: 500, output_tokens: 50 });
        appendDeepRun(dir, { enabled: true, status: 'ok', tier: 'lite' });
        appendDeepRun(dir, { enabled: true, status: 'error', tier: 'cloud', cost_usd: 9 }); // nothing ran: not a run
        const runs = readDeepRuns(dir);
        expect(runs).toHaveLength(3);
        expect(summarizeDeepRuns(runs)).toEqual({
            runs: 3, costUsd: 0.25, unpricedRuns: 1, inputTokens: 1500, outputTokens: 150,
            functionsRanked: 10, functionsRouted: 3, alreadyReviewed: 1, toolCalls: 7, findingsKept: 2,
        });
    });
});
