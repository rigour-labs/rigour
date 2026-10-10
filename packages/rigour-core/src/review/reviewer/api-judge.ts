/**
 * A judge reached through a model API instead of an agent CLI, so any model a team can call works as
 * a reviewer: OpenAI-compatible chat completions with tools (OpenAI, OpenRouter, a local server, other
 * vendors through a gateway). Rigour runs the loop itself: the model asks for a read-only tool, Rigour
 * runs it inside the checkout (and the review's own input folder) and hands the result back, until
 * the model answers. The same prompt, the same evidence contract and the same trace as a CLI judge;
 * the key comes from an environment variable named in rigour.yml, never from the file.
 */
import fs from 'fs';
import path from 'path';
import { execa } from 'execa';
import type { RunTrace } from './adapters.js';

export type Reasoning = 'low' | 'medium' | 'high';

export interface ApiJudgeOptions {
    /** The API's base URL; `/chat/completions` is appended. */
    url: string;
    model: string;
    key: string;
    maxTurns: number;
    timeoutMs: number;
    cwd: string;
    /** Where the tools may read: the checkout and the review's input folder. */
    roots: string[];
    reasoning?: Reasoning;
    fetchImpl?: typeof fetch;
    /** The review's input files, given inline in the first message: a model that never calls a tool still has what it needs. */
    inputs?: Array<{ path: string; text: string }>;
    /**
     * Ask the API to cache the conversation so far (`cache_control` on the request), for models that cache only when
     * asked (Claude). Each turn re-sends the whole conversation, so every turn after the first reads the earlier turns
     * from the cache. An API that refuses the field on the first turn is asked again without it, and never again.
     */
    cache?: boolean;
}

export interface ApiJudgeRun { exitCode: number; stdout: string; stderr: string }

/** What a run's stdout carries on success, for the adapter to read. */
export interface ApiJudgeAnswer { result: string; usage: RunTrace['usage']; cost_usd?: number; trace: RunTrace }

const SYSTEM = 'You review code with read-only tools. Read the files the task names with read_file (the review inputs are named by absolute path), search the repository with search, read history with git. When you are done, reply with the final answer the task asks for and nothing else.';
const MAX_RESULT_CHARS = 60_000;
/** Output tokens a turn may use, reasoning included: a review verdict is long, and a reasoning model's thinking counts against the default budget. */
const MAX_OUTPUT_TOKENS = 32_000;
/** Characters of the inputs given inline in the first message; the rest stays in the files, for the tools. */
const MAX_INLINE_CHARS = 240_000;
const GIT_ALLOWED = new Set(['log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'rev-parse', 'merge-base']);
/** Git options that write, or point git at another repository. */
const GIT_REFUSED = /^(--output|-o$|--git-dir|--work-tree|-C$|--exec-path|-c$|--config-env)/;

const TOOLS = [
    { type: 'function', function: { name: 'read_file', description: 'Read a file in the repository or the review inputs, or a line range of it.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'search', description: 'Search the tracked files for a regular expression (git grep -n), optionally under one path.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
    { type: 'function', function: { name: 'list_dir', description: 'List a directory in the repository or the review inputs.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'git', description: 'Run a read-only git command in the repository: log, show, diff, blame, grep, ls-files, rev-parse, merge-base.', parameters: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } } },
];

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export async function runApiJudge(prompt: string, o: ApiJudgeOptions): Promise<ApiJudgeRun> {
    const fetchImpl = o.fetchImpl ?? fetch;
    const deadline = Date.now() + o.timeoutMs;
    const messages: any[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: withInputs(prompt, o.inputs ?? []) }];
    const usage: RunTrace['usage'] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const calls: RunTrace['calls'] = [];
    let cost: number | undefined;
    let cache = o.cache === true;
    const fail = (why: string): ApiJudgeRun => ({ exitCode: 1, stdout: '', stderr: `api judge (${o.model}): ${why}` });
    for (let turn = 1; turn <= o.maxTurns; turn++) {
        const left = deadline - Date.now();
        if (left <= 0) return fail(`timed out after ${o.timeoutMs} ms`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), left);
        const send = () => fetchImpl(`${o.url.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${o.key}` },
            body: JSON.stringify({ model: o.model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: MAX_OUTPUT_TOKENS, ...(o.reasoning ? { reasoning_effort: o.reasoning } : {}), ...(cache ? { cache_control: { type: 'ephemeral' } } : {}) }),
            signal: controller.signal,
        });
        let response: Response;
        try {
            response = await send();
            if (response.status === 400 && cache && turn === 1) {
                cache = false;
                response = await send();
            }
        } catch (error) {
            return fail(`request failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) return fail(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        let body: any;
        try {
            body = await response.json();
        } catch {
            return fail('the answer was not JSON');
        }
        const u = body.usage ?? {};
        const cached = n(u.prompt_tokens_details?.cached_tokens);
        const written = n(u.prompt_tokens_details?.cache_write_tokens);
        usage.input += Math.max(0, n(u.prompt_tokens) - cached - written);
        usage.cacheRead += cached;
        usage.cacheWrite += written;
        usage.output += n(u.completion_tokens);
        if (typeof u.cost === 'number') cost = (cost ?? 0) + u.cost;
        const choice = body.choices?.[0];
        // A gateway reports a provider's failure inside the choice, with the choice's finish_reason "error": say what it said.
        if (choice?.error || body.error) return fail(`the API reported an error: ${JSON.stringify(choice?.error ?? body.error).slice(0, 300)}`);
        const message = choice?.message;
        if (!message) return fail('no choices in the answer');
        // Echo back what the API needs to continue (reasoning_details carries a reasoning model's chain), not the reasoning prose.
        messages.push({ role: 'assistant', content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}) });
        const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        if (toolCalls.length === 0) {
            const text = String(message.content ?? '').trim();
            // An empty final message is not an answer: say why (the output budget ran out, a refusal), never report it as one.
            if (!text) return fail(`an empty answer on turn ${turn} (finish_reason ${String(body.choices?.[0]?.finish_reason ?? 'unknown')}${message.refusal ? `, refusal: ${String(message.refusal).slice(0, 120)}` : ''})`);
            const answer: ApiJudgeAnswer = { result: text, usage, ...(cost !== undefined ? { cost_usd: cost } : {}), trace: { turns: turn, usage, calls } };
            return { exitCode: 0, stdout: JSON.stringify(answer), stderr: '' };
        }
        for (const call of toolCalls) {
            const ran = await runTool(call, o);
            calls.push({ turn, tool: ran.tool, target: ran.target, resultChars: ran.result.length });
            messages.push({ role: 'tool', tool_call_id: call.id, content: ran.result });
        }
    }
    return fail(`no answer within ${o.maxTurns} turns`);
}

/**
 * The prompt with the inputs it names appended inline, smallest first so the diff takes what budget is left: a judge
 * is fed, not left to decide whether to read. What does not fit is cut with a note naming the file to read.
 */
function withInputs(prompt: string, inputs: Array<{ path: string; text: string }>): string {
    if (inputs.length === 0) return prompt;
    const ordered = [...inputs].sort((a, b) => a.text.length - b.text.length);
    let left = MAX_INLINE_CHARS;
    const parts = ordered.map(input => {
        const text = input.text.length > left ? `${input.text.slice(0, Math.max(0, left))}\n…[cut here: read ${input.path} with read_file for the rest]` : input.text;
        left = Math.max(0, left - input.text.length);
        return `### ${input.path}\n${text}`;
    });
    return `${prompt}\n\nThe inputs named above, inline (the files are also there for your tools):\n\n${parts.join('\n\n')}`;
}

/** One tool call, inside the allowed roots only; the trace names tools as the CLI judges do (Read, Grep, Glob, Bash). */
async function runTool(call: any, o: ApiJudgeOptions): Promise<{ tool: string; target: string; result: string }> {
    const name = String(call?.function?.name ?? '');
    let args: any = {};
    try {
        args = JSON.parse(call?.function?.arguments || '{}');
    } catch {
        return { tool: name, target: '', result: 'refused: the arguments were not JSON' };
    }
    const clip = (text: string) => (text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated at ${MAX_RESULT_CHARS} characters]` : text);
    if (name === 'read_file') {
        const target = inside(String(args.path ?? ''), o);
        if (!target) return { tool: 'Read', target: String(args.path ?? ''), result: 'refused: outside the repository and the review inputs' };
        try {
            const lines = fs.readFileSync(target, 'utf8').split('\n');
            const start = Math.max(1, Number(args.start_line) || 1);
            const end = Math.min(lines.length, Number(args.end_line) || lines.length);
            return { tool: 'Read', target, result: clip(lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n')) };
        } catch (error) {
            return { tool: 'Read', target, result: `error: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    if (name === 'list_dir') {
        const target = inside(String(args.path ?? '.'), o);
        if (!target) return { tool: 'Glob', target: String(args.path ?? ''), result: 'refused: outside the repository and the review inputs' };
        try {
            return { tool: 'Glob', target, result: clip(fs.readdirSync(target, { withFileTypes: true }).map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n')) };
        } catch (error) {
            return { tool: 'Glob', target, result: `error: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
    if (name === 'search') {
        const pattern = String(args.pattern ?? '');
        const under = args.path ? inside(String(args.path), o) : undefined;
        if (args.path && !under) return { tool: 'Grep', target: pattern, result: 'refused: outside the repository' };
        const run = await execa('git', ['grep', '-n', '-I', '-e', pattern, ...(under ? ['--', path.relative(o.cwd, under) || '.'] : [])], { cwd: o.cwd, reject: false, maxBuffer: 16 * 1024 * 1024 });
        return { tool: 'Grep', target: pattern, result: clip(run.stdout || (run.exitCode === 1 ? '(no match)' : run.stderr)) };
    }
    if (name === 'git') {
        const gitArgs: string[] = Array.isArray(args.args) ? args.args.map(String) : [];
        if (!GIT_ALLOWED.has(gitArgs[0] ?? '') || gitArgs.some(a => GIT_REFUSED.test(a))) return { tool: 'Bash', target: `git ${gitArgs.join(' ')}`, result: 'refused: only read-only git commands, without options that write or point elsewhere' };
        const run = await execa('git', ['--no-pager', ...gitArgs], { cwd: o.cwd, reject: false, maxBuffer: 16 * 1024 * 1024 });
        return { tool: 'Bash', target: `git ${gitArgs.join(' ')}`, result: clip(run.stdout || run.stderr) };
    }
    return { tool: name, target: '', result: `refused: no tool named ${name}` };
}

/** The real path of `p` when it lies under one of the roots; undefined otherwise (a symlink out is outside). */
function inside(p: string, o: ApiJudgeOptions): string | undefined {
    const resolved = path.resolve(o.cwd, p);
    let real: string;
    try {
        real = fs.realpathSync(resolved);
    } catch {
        return undefined;
    }
    for (const root of o.roots) {
        let base: string;
        try {
            base = fs.realpathSync(root);
        } catch {
            continue;
        }
        if (real === base || real.startsWith(base + path.sep)) return real;
    }
    return undefined;
}
