import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import type { Exec } from './exec.js';
import { ruleWriterFor } from './rule-writer.js';

let repo: string;
let bin: string;
const originalPath = process.env.PATH;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-writer-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'rule-writer-bin-'));
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = [bin, originalPath ?? ''].join(path.delimiter);
});
afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of [repo, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Answers git for real, the fake claude with a priced reply, and any other copy of claude as not installed. */
function fake(calls: Array<{ args: string[]; unset?: string[] }>): Exec {
    return async (command, args, options) => {
        if (command === 'git') return { exitCode: 0, stdout: execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8' }), stderr: '' };
        if (!command.startsWith(bin)) return { exitCode: 127, stdout: '', stderr: 'not found' };
        if (args[0] === '--version') return { exitCode: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' };
        calls.push({ args, unset: options.unset });
        return { exitCode: 0, stdout: JSON.stringify({ result: '{"rules":[]}', total_cost_usd: 0.6 }), stderr: '' };
    };
}

describe('the rule writer', () => {
    it('runs the team reviewer CLI isolated like a judge, counts its cost, and stops at the daily cap', async () => {
        const calls: Array<{ args: string[]; unset?: string[] }> = [];
        const config = ConfigSchema.parse({ version: 1, review: { reviewer: { reviewers: ['claude'], max_usd_per_day: 1 } } });
        const write = (await ruleWriterFor(repo, config, fake(calls)))!;
        expect(await write('first')).toBe('{"rules":[]}');
        expect(await write('second')).toBe('{"rules":[]}'); // $0.60 spent: under the $1 cap
        expect(await write('third')).toBeUndefined(); // $1.20: the cap is reached, no call made
        expect(calls).toHaveLength(2);
        expect(calls[0].args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disallowedTools', 'Edit', 'Write']));
        expect(calls[0].unset).toContain('RIGOUR_API_KEY');
    });

    it("stops one rule-writing run at its cost cap, and a later run starts afresh", async () => {
        const calls: Array<{ args: string[]; unset?: string[] }> = [];
        const config = ConfigSchema.parse({ version: 1, review: { reviewer: { reviewers: ['claude'], max_usd_per_day: 100, max_usd_per_review: 1 } } });
        const write = (await ruleWriterFor(repo, config, fake(calls)))!;
        expect(await write('first')).toBe('{"rules":[]}');
        expect(await write('second')).toBe('{"rules":[]}'); // $0.60 spent by this run: under its $1 cap
        expect(await write('third')).toBeUndefined(); // $1.20: this run's cap, no call made
        const later = (await ruleWriterFor(repo, config, fake(calls)))!;
        expect(await later('fourth')).toBe('{"rules":[]}'); // the day's caps still have room
        expect(calls).toHaveLength(3);
    });

    it('is not available when no reviewer CLI is installed', async () => {
        const config = ConfigSchema.parse({ version: 1, review: { reviewer: { reviewers: ['codex'] } } });
        expect(await ruleWriterFor(repo, config, fake([]))).toBeUndefined();
    });
});
