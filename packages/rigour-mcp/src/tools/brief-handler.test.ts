import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '@rigour-labs/core';
import { handleBrief } from './brief-handler.js';

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-mcp-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'feat/retry']);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '- Every job in `src/jobs/` must take `withLock()` before its first read; a job that reads first double-sends.\n');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('rigour_brief', () => {
    it('briefs any agent from its goal and files, and says so when the team switched briefings off', () => {
        const on = handleBrief(repo, ConfigSchema.parse({ version: 1 }), { goal: 'retry the job', files: ['src/jobs/retry.ts'] });
        expect(on.content[0].text).toContain('1. [must] Every job in `src/jobs/` must take `withLock()`');
        const off = handleBrief(repo, ConfigSchema.parse({ version: 1, brief: { enabled: false } }), { goal: 'retry the job' });
        expect(off.content[0].text).toContain('switched off');
        const none = handleBrief(repo, ConfigSchema.parse({ version: 1 }), { goal: 'reword the readme', files: ['README.md'] });
        expect(none.content[0].text).toContain('Nothing to brief');
    });
});
