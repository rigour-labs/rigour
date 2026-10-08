import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import type { Exec } from '../review/reviewer/exec.js';
import { readThread } from '../task/thread.js';
import { hookGoalDescription, recordGoal } from './hook.js';

let repo: string;
const on = ConfigSchema.parse({ version: 1, review: { goal: 'on' } });
const savedEnv = { RIGOUR_GOAL: process.env.RIGOUR_GOAL, GH_TOKEN: process.env.GH_TOKEN, RIGOUR_GITHUB_ACCOUNT: process.env.RIGOUR_GITHUB_ACCOUNT };

/** A gh that answers `pr view` with `reply` (or fails), and counts its calls. */
function gh(reply: { state: string; body: string } | 'fail' | 'none', calls: string[][]): Exec {
    return async (_command, args, options) => {
        calls.push([...args, `timeout ${options.timeoutMs}`]);
        if (reply === 'fail') return { exitCode: 1, stdout: '', stderr: 'error connecting to api.github.com' };
        if (reply === 'none') return { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "feature"' };
        return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' };
    };
}

beforeEach(() => {
    for (const key of Object.keys(savedEnv)) delete process.env[key];
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-hook-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'feature');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'init');
});
afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('the goal at a stop or a push', () => {
    it('never asks GitHub with the goal check off', async () => {
        const calls: string[][] = [];
        expect(await hookGoalDescription(repo, ConfigSchema.parse({ version: 1 }), gh({ state: 'OPEN', body: 'x' }, calls))).toBeUndefined();
        expect(calls).toEqual([]);
    });

    it('reads the open pull request\'s description once per HEAD, with a 5 second budget', async () => {
        const calls: string[][] = [];
        const exec = gh({ state: 'OPEN', body: '## Scope\n- `src/`' }, calls);
        expect(await hookGoalDescription(repo, on, exec)).toBe('## Scope\n- `src/`');
        expect(await hookGoalDescription(repo, on, exec)).toBe('## Scope\n- `src/`');
        expect(calls).toEqual([['pr', 'view', 'feature', '--json', 'state,body', 'timeout 5000']]);
    });

    it('spends 5 seconds in all, the token call included', async () => {
        const timeouts: number[] = [];
        const slow: Exec = async (_command, args, options) => {
            timeouts.push(options.timeoutMs);
            if (args[0] === 'auth') { await new Promise(resolve => setTimeout(resolve, 50)); return { exitCode: 0, stdout: 'token\n', stderr: '' }; }
            return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', body: 'x' }), stderr: '' };
        };
        await hookGoalDescription(repo, ConfigSchema.parse({ version: 1, review: { goal: 'on', github_account: 'someone' } }), slow);
        expect(timeouts[0]).toBe(5000);
        expect(timeouts[1]).toBeLessThanOrEqual(5000 - 50);
    });

    it('reads the description again on the commit it blocked: the fix may be the description', async () => {
        const calls: string[][] = [];
        let body = '## Scope\n- `src/`';
        const exec: Exec = async (_command, args) => { calls.push(args); return { exitCode: 0, stdout: JSON.stringify({ state: 'OPEN', body }), stderr: '' }; };
        expect(await hookGoalDescription(repo, on, exec)).toBe(body);
        recordGoal(repo, 'push', body, { findings: [{ id: 'goal-scope', title: 't', details: 'd' }] });
        body = '## Scope\n- `src/`\n- `docs/`';
        expect(await hookGoalDescription(repo, on, exec)).toBe(body);
        expect(calls).toHaveLength(2);
    });

    it('checks nothing, and never throws, with no pull request, a closed one, or gh failing', async () => {
        for (const reply of ['none', 'fail', { state: 'MERGED', body: '## Scope\n- `src/`' }] as const) {
            fs.rmSync(path.join(repo, '.git', 'rigour'), { recursive: true, force: true });
            expect(await hookGoalDescription(repo, on, gh(reply, []))).toBeUndefined();
        }
        const throwing: Exec = async () => { throw new Error('spawn gh ENOENT'); };
        fs.rmSync(path.join(repo, '.git', 'rigour'), { recursive: true, force: true });
        expect(await hookGoalDescription(repo, on, throwing)).toBeUndefined();
    });

    it('records what it did on the task\'s thread, and nothing without a description', () => {
        recordGoal(repo, 'push', undefined, { findings: [] });
        recordGoal(repo, 'push', '## Scope\n- `src/`', { goal: { doneWhen: [], scope: ['src/'], outOfScope: [], invariants: [] }, findings: [{ id: 'goal-scope', title: 't', details: 'd' }] });
        expect(readThread(repo)!.events.filter(e => e.kind === 'goal').map(e => [e.moment, e.declared, e.blocks])).toEqual([['push', true, 1]]);
    });
});
