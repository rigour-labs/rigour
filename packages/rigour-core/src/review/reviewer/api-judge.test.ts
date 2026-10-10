import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApiJudge, type ApiJudgeAnswer } from './api-judge.js';

let repo: string;
let work: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'api-judge-'));
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'api-judge-inputs-'));
    execFileSync('git', ['-C', repo, 'init', '-q']);
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/job.ts'), 'export function job() {\n    return 1;\n}\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    fs.writeFileSync(path.join(work, 'full.diff'), '+++ b/src/job.ts\n');
});
afterEach(() => { for (const d of [repo, work]) fs.rmSync(d, { recursive: true, force: true }); });

/** A model that plays a scripted conversation: each entry is what it answers to the next request. */
function model(turns: Array<{ tools?: Array<{ name: string; args: object }>; text?: string; usage?: object; status?: number }>) {
    const seen: any[] = [];
    let i = 0;
    const fetchImpl = (async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        seen.push(body);
        const turn = turns[i++] ?? { text: 'done' };
        if (turn.status) return new Response('nope', { status: turn.status });
        const message = turn.tools
            ? { role: 'assistant', content: null, tool_calls: turn.tools.map((t, k) => ({ id: `c${i}-${k}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) }
            : { role: 'assistant', content: turn.text };
        return new Response(JSON.stringify({ choices: [{ message }], usage: turn.usage ?? { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
}

const options = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof runApiJudge>[1]> = {}) => ({ url: 'https://example.test/v1', model: 'some-model', key: 'k', maxTurns: 10, timeoutMs: 30_000, cwd: repo, roots: [repo, work], fetchImpl, ...extra });

describe('the API judge', () => {
    it('runs the tools the model asks for inside the checkout and the inputs, then returns its answer with the usage and the trace', async () => {
        const { fetchImpl, seen } = model([
            { tools: [{ name: 'read_file', args: { path: path.join(work, 'full.diff') } }, { name: 'read_file', args: { path: 'src/job.ts', start_line: 2, end_line: 2 } }] },
            { tools: [{ name: 'search', args: { pattern: 'return' } }, { name: 'git', args: { args: ['log', '-1', '--format=%s'] } }, { name: 'list_dir', args: { path: 'src' } }] },
            { text: '{"prior_points":[]}', usage: { prompt_tokens: 50, completion_tokens: 5, cost: 0.01 } },
        ]);
        const run = await runApiJudge('review this', options(fetchImpl));
        expect(run.exitCode).toBe(0);
        const answer: ApiJudgeAnswer = JSON.parse(run.stdout);
        expect(answer.result).toBe('{"prior_points":[]}');
        expect(answer.usage).toEqual({ input: 130, cacheRead: 120, cacheWrite: 0, output: 25 });
        expect(answer.cost_usd).toBe(0.01);
        expect(answer.trace.turns).toBe(3);
        expect(answer.trace.calls.map(c => c.tool)).toEqual(['Read', 'Read', 'Grep', 'Bash', 'Glob']);
        const toolResults = (request: any) => request.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
        expect(toolResults(seen[1])).toEqual(['1: +++ b/src/job.ts\n2: ', '2:     return 1;']); // turn 1's reads, as the model got them
        expect(toolResults(seen[2]).slice(2)).toEqual(['src/job.ts:2:    return 1;', 'init', 'job.ts']); // turn 2's search, git and listing
        expect(seen[0].messages[0].role).toBe('system');
        expect(seen[0].tools.map((t: any) => t.function.name)).toEqual(['read_file', 'search', 'list_dir', 'git']);
    });

    it('refuses to read outside the roots, a symlink out included, and refuses git that writes or points elsewhere', async () => {
        fs.symlinkSync(os.homedir(), path.join(repo, 'out'));
        const { fetchImpl, seen } = model([
            { tools: [{ name: 'read_file', args: { path: '/etc/hosts' } }, { name: 'read_file', args: { path: 'out/.bashrc' } }, { name: 'git', args: { args: ['log', '--output=/tmp/x'] } }, { name: 'git', args: { args: ['push'] } }, { name: 'nope', args: {} }] },
            { text: 'ok' },
        ]);
        await runApiJudge('p', options(fetchImpl));
        const results = seen[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
        expect(results).toEqual([
            'refused: outside the repository and the review inputs', 'refused: outside the repository and the review inputs',
            'refused: only read-only git commands, without options that write or point elsewhere', 'refused: only read-only git commands, without options that write or point elsewhere',
            'refused: no tool named nope',
        ]);
    });

    it('fails closed on a turn cap, an HTTP error and a timeout, saying why', async () => {
        const loop = model(Array.from({ length: 5 }, () => ({ tools: [{ name: 'list_dir', args: { path: '.' } }] })));
        expect(await runApiJudge('p', options(loop.fetchImpl, { maxTurns: 3 }))).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('no answer within 3 turns') });
        expect(await runApiJudge('p', options(model([{ status: 429 }]).fetchImpl))).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('HTTP 429') });
        const slow = (async (_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
        expect(await runApiJudge('p', options(slow, { timeoutMs: 50 }))).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('request failed') });
    });

    it('fails closed on an empty final message, saying why, and echoes back only what the API needs to continue', async () => {
        const empty = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', reasoning: 'thinking…' }, finish_reason: 'length' }], usage: {} }), { status: 200 })) as unknown as typeof fetch;
        expect(await runApiJudge('p', options(empty))).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('an empty answer on turn 1 (finish_reason length)') });
        const providerError = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'error', error: { message: 'Provider returned error', code: 502 } }], usage: {} }), { status: 200 })) as unknown as typeof fetch;
        expect(await runApiJudge('p', options(providerError))).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('the API reported an error: {"message":"Provider returned error","code":502}') });
        const { fetchImpl, seen } = model([{ tools: [{ name: 'list_dir', args: { path: '.' } }] }, { text: 'ok' }]);
        await runApiJudge('p', options(fetchImpl));
        const echoed = seen[1].messages.find((m: any) => m.role === 'assistant');
        expect(Object.keys(echoed).sort()).toEqual(['content', 'role', 'tool_calls']); // no reasoning prose sent back
        expect(seen[0].max_tokens).toBe(32000);
    });

    it('gives the judge its inputs inline, smallest first, the diff cut with a note when the budget runs out', async () => {
        const { fetchImpl, seen } = model([{ text: 'ok' }]);
        const inputs = [{ path: '/w/full.diff', text: 'x'.repeat(300_000) }, { path: '/w/pr-description.md', text: 'the description' }, { path: '/w/previous-reviews.md', text: 'the reviews' }];
        await runApiJudge('review this', options(fetchImpl, { inputs }));
        const first = seen[0].messages[1].content as string;
        expect(first.startsWith('review this\n\nThe inputs named above, inline')).toBe(true);
        expect(first.indexOf('### /w/previous-reviews.md')).toBeLessThan(first.indexOf('### /w/full.diff')); // smallest first
        expect(first).toContain('…[cut here: read /w/full.diff with read_file for the rest]');
        expect(first.length).toBeLessThan(241_000);
    });

    it('asks for the cache on every turn when told to, and counts what it wrote and read', async () => {
        const { fetchImpl, seen } = model([
            { tools: [{ name: 'list_dir', args: { path: 'src' } }], usage: { prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 2900 } } },
            { text: 'ok', usage: { prompt_tokens: 3100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2900, cache_write_tokens: 150 } } },
        ]);
        const answer: ApiJudgeAnswer = JSON.parse((await runApiJudge('p', options(fetchImpl, { cache: true }))).stdout);
        expect(seen.map(r => r.cache_control)).toEqual([{ type: 'ephemeral' }, { type: 'ephemeral' }]);
        expect(answer.usage).toEqual({ input: 150, cacheRead: 2900, cacheWrite: 3050, output: 15 });
        const { fetchImpl: plain, seen: plainSeen } = model([{ text: 'ok' }]);
        await runApiJudge('p', options(plain));
        expect(plainSeen[0].cache_control).toBeUndefined();
    });

    it('asks again without the cache when the API refuses it on the first turn, and does not ask for it again', async () => {
        const { fetchImpl, seen } = model([{ status: 400 }, { tools: [{ name: 'list_dir', args: { path: 'src' } }] }, { text: 'ok' }]);
        const run = await runApiJudge('p', options(fetchImpl, { cache: true }));
        expect(run.exitCode).toBe(0);
        expect(seen.map(r => r.cache_control)).toEqual([{ type: 'ephemeral' }, undefined, undefined]);
    });

    it('passes the reasoning effort when asked', async () => {
        const { fetchImpl, seen } = model([{ text: 'ok' }]);
        await runApiJudge('p', options(fetchImpl, { reasoning: 'low' }));
        expect(seen[0].reasoning_effort).toBe('low');
        expect(seen[0].model).toBe('some-model');
    });
});
