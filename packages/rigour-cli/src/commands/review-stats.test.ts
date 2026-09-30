import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendAgentEvent } from '@rigour-labs/core';
import { reviewStatsCommand } from './review-stats.js';

describe('rigour review-stats', () => {
    let dir: string | undefined;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; vi.restoreAllMocks(); });

    it('reports the loop from the local event log as JSON', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-stats-'));
        appendAgentEvent(dir, { type: 'stop_review', session: 's', blocked: true });
        appendAgentEvent(dir, { type: 'stop_review', session: 's', blocked: false });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        reviewStatsCommand(dir, { json: true });
        expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ stopChecks: 2, stopBlocks: 1, blockedStopsFollowedThrough: 1 });
    });
});
