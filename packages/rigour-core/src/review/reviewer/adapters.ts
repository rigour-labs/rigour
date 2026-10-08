/**
 * Reviewer adapters: the person's own coding-agent CLIs, each run headless and read-only on the
 * same prompt. `review.reviewer.reviewers` is the contract (an explicit list, any vendors); the
 * mode picks among it: `single` runs the first available (the default, and the fastest), `cross`
 * prefers a vendor not on the commits' Co-Authored-By trailers, `full` runs two vendors and the
 * verdicts are merged. Which mode earns its minutes is decided by the backtest ledger, which
 * records the reviewer behind each catch, not by preference.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultExec, type Exec } from './exec.js';

export type ReviewerName = 'claude' | 'cursor' | 'codex' | 'api';
export type Vendor = 'anthropic' | 'cursor' | 'openai' | 'google' | 'other';
export type ReviewMode = 'single' | 'cross' | 'full';

export interface Adapter {
    vendor: Vendor;
    binary: string;
    /** The command line for one review: the prompt is passed as text, never through a shell. */
    args(prompt: string, model: string | undefined, options?: { reasoning?: 'low' | 'medium' | 'high' }): string[];
    /** The reviewer's final message and, when the CLI reports them, what the run cost and the tokens it used. */
    answer(stdout: string): { text: string } & Spend;
    /** Variables the judge runs with, on top of what it inherits: what keeps a person's own instructions out of it. */
    env?: Record<string, string>;
    /** What this judge still reads from outside the repository on this machine (a person's own config), or undefined: said on the record, never hidden. */
    outsideRepo?(home: string): string | undefined;
}

/** What a run used: dollars when the CLI reports them (Claude Code), tokens otherwise (Codex reports only tokens). */
export interface Spend { costUsd?: number; tokens?: Tokens; trace?: RunTrace }

/**
 * Where a run's tokens went, turn by turn, and what each tool call read: measurement only, never a
 * decision. `category` is filled in by the reviewer, which knows its own input files and the change.
 */
export interface RunTrace {
    turns: number;
    usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
    calls: Array<{ turn: number; tool: string; target: string; resultChars: number; category?: 'rigour-input' | 'changed-file' | 'other-file' | 'git' | 'search' | 'other' }>;
}
export interface Tokens { input: number; output: number }

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)', 'Bash(git grep:*)'];

export const ADAPTERS: Record<ReviewerName, Adapter> = {
    claude: {
        vendor: 'anthropic',
        binary: 'claude',
        // Isolated: no MCP servers, no hooks, no user-level settings (an output style or permission
        // of the author's session must not shape the reviewer), read-only tools.
        args: (prompt, model) => [
            '-p', prompt,
            ...(model ? ['--model', model] : []),
            '--output-format', 'stream-json', '--verbose', // every turn's usage and tool calls, for the run's trace
            '--max-turns', '80',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--setting-sources', 'project', '--settings', '{"hooks":{},"outputStyle":"default"}',
            '--allowedTools', ...READ_ONLY_TOOLS,
            '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)', 'Bash(git commit:*)',
        ],
        // No memory file loads itself: not ~/.claude/CLAUDE.md, not one in a folder above the repository, not the repository's
        // own (the judge reads the repository's rules as files, as Rigour's prompt tells every judge to), and no auto-memory.
        // Claude Code's own safe mode uses the same switch. What the judge knows is the repository and what Rigour gives it.
        env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
        answer: stdout => claudeAnswer(stdout),
    },
    cursor: {
        vendor: 'cursor',
        binary: 'cursor-agent',
        // Ask mode is read-only and cannot run git: every input the prompt names is a file.
        outsideRepo: () => 'cursor also reads your own Cursor rules and settings',
        args: (prompt, model) => ['-p', '--print', '--output-format', 'json', '--trust', '--mode', 'ask', '--model', model ?? 'auto', prompt],
        answer: stdout => {
            try {
                const pick = (o: any): string => typeof o === 'string' ? o : o && typeof o === 'object' ? (Array.isArray(o) ? pick(o[o.length - 1]) : String(o.result ?? o.text ?? o.content ?? o.message ?? '')) : '';
                return { text: pick(JSON.parse(stdout)) };
            } catch {
                return { text: stdout };
            }
        },
    },
    codex: {
        vendor: 'openai',
        binary: 'codex',
        // Codex has no switch that skips a person's ~/.codex/config.toml and ~/.codex/AGENTS.md and keeps their login, so the
        // record says when those exist rather than claiming a judge that only knows the repository.
        outsideRepo: home => {
            const dir = process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
            const read = ['config.toml', 'AGENTS.md'].filter(name => fs.existsSync(path.join(dir, name)));
            return read.length ? `codex also reads ${read.map(name => path.join(dir, name)).join(' and ')}` : undefined;
        },
        args: (prompt, model, options) => ['exec', '--sandbox', 'read-only', '--json', ...(model ? ['--model', model] : []), '-c', `model_reasoning_effort=${options?.reasoning ?? 'high'}`, prompt],
        // `codex exec --json` streams events; the last text-bearing one carries the answer.
        // Warnings arrive as `error` items with a `message`, not `text`, so they are never taken for the answer.
        // `turn.completed` carries the tokens (Codex reports no dollars).
        answer: stdout => {
            let text = '';
            let tokens: Tokens | undefined;
            for (const line of stdout.split('\n').filter(Boolean)) {
                try {
                    const event = JSON.parse(line);
                    const candidate = event?.item?.text ?? event?.msg?.message ?? event?.text;
                    if (typeof candidate === 'string') text = candidate;
                    if (event?.type === 'turn.completed' && event.usage) tokens = { input: n(event.usage.input_tokens), output: n(event.usage.output_tokens) + n(event.usage.reasoning_output_tokens) };
                } catch {
                    // not an event line
                }
            }
            return { text: text || stdout, ...(tokens ? { tokens } : {}) };
        },
    },
    api: {
        // A model API, not a CLI: reviewer.ts runs the loop (api-judge.ts); the answer is the loop's JSON.
        vendor: 'other',
        binary: 'api',
        args: () => [],
        answer: stdout => {
            try {
                const parsed = JSON.parse(stdout);
                const u = parsed.usage ?? {};
                return {
                    text: String(parsed.result ?? ''),
                    ...(typeof parsed.cost_usd === 'number' ? { costUsd: parsed.cost_usd } : {}),
                    tokens: { input: n(u.input) + n(u.cacheRead) + n(u.cacheWrite), output: n(u.output) },
                    ...(parsed.trace ? { trace: parsed.trace } : {}),
                };
            } catch {
                return { text: stdout };
            }
        },
    },
};

export function isReviewerName(name: string): name is ReviewerName {
    return name in ADAPTERS;
}

export interface Installed { binary: string; version: string }

/** Where a CLI tends to be installed besides PATH: a global npm prefix, Homebrew, a user-local bin, the agent's own installer. */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.claude', 'local')];

/**
 * The newest installed copy of the adapter's CLI, or undefined when none is. Several copies are
 * common (an old global npm install first on PATH, a current one from Homebrew), and the old one
 * refuses current models, so the version decides, not PATH order.
 */
export async function resolveAdapter(adapter: Adapter, cwd: string, exec: Exec): Promise<Installed | undefined> {
    if (adapter.binary === 'api') return undefined; // never a binary: reviewer.ts installs it from review.reviewer.api
    const names = process.platform === 'win32' ? [`${adapter.binary}.cmd`, `${adapter.binary}.exe`, adapter.binary] : [adapter.binary];
    const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_BIN_DIRS].filter(Boolean);
    const candidates = new Set<string>();
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (executable(candidate)) candidates.add(candidate);
        }
    }
    let best: Installed | undefined;
    for (const binary of candidates) {
        const result = await exec(binary, ['--version'], { cwd, timeoutMs: 20_000 });
        if (result.exitCode !== 0) continue;
        const version = result.stdout.trim().split('\n')[0];
        if (!best || newer(version, best.version)) best = { binary, version };
    }
    return best;
}

function executable(file: string): boolean {
    try {
        fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** `a` carries a higher dotted version than `b` (the first such run of digits in each line). */
function newer(a: string, b: string): boolean {
    const parse = (line: string) => (line.match(/\d+(?:\.\d+)+/)?.[0] ?? '0').split('.').map(Number);
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

/** Which vendors wrote the commits, from their Co-Authored-By trailers. No trailer means a person. */
export function vendorsOf(trailers: string): Set<Vendor> {
    const vendors = new Set<Vendor>();
    for (const line of trailers.toLowerCase().split('\n')) {
        if (/claude/.test(line)) vendors.add('anthropic');
        if (/cursor/.test(line)) vendors.add('cursor');
        if (/codex|openai/.test(line)) vendors.add('openai');
    }
    return vendors;
}

/**
 * The reviewers a run uses. single: the first available of the list. cross: the first available
 * whose vendor is not on the trailers, else the first available. full: that one plus the next
 * available of each other vendor, up to `judges`. Empty when none is installed.
 */
export function selectReviewers(candidates: ReviewerName[], mode: ReviewMode, authors: Set<Vendor>, available: Set<ReviewerName>, judges = 2, vendorOf: (name: ReviewerName) => Vendor = name => ADAPTERS[name].vendor): ReviewerName[] {
    const installed = candidates.filter(name => available.has(name));
    if (installed.length === 0) return [];
    let first = installed[0];
    if (mode !== 'single') first = installed.find(name => !authors.has(vendorOf(name))) ?? first;
    if (mode !== 'full') return [first];
    const chosen = [first];
    for (const name of installed) {
        if (chosen.length >= judges) break;
        if (!chosen.some(c => vendorOf(c) === vendorOf(name))) chosen.push(name);
    }
    return chosen;
}

/** The maker of an API judge's model: what the team said, else what the model's name says, else other. */
export function apiVendor(api: { model: string; vendor?: Vendor } | undefined): Vendor {
    if (!api) return 'other';
    if (api.vendor) return api.vendor;
    const model = api.model.toLowerCase();
    if (/claude|anthropic/.test(model)) return 'anthropic';
    if (/gpt|openai|^o[1-9]/.test(model)) return 'openai';
    if (/gemini|google/.test(model)) return 'google';
    return 'other';
}

/** Every reviewer Rigour can run, and whether this machine has it: what bounds the judges of a panel. */
export async function reviewerAvailability(cwd: string, exec: Exec = defaultExec): Promise<Array<{ name: ReviewerName; vendor: Vendor; binary: string; installed: boolean; version?: string }>> {
    // The CLIs only: the api judge is configured, not installed (reviewer.ts).
    return Promise.all((Object.keys(ADAPTERS) as ReviewerName[]).filter(name => ADAPTERS[name].binary !== 'api').map(async name => {
        const found = await resolveAdapter(ADAPTERS[name], cwd, exec);
        return { name, vendor: ADAPTERS[name].vendor, binary: ADAPTERS[name].binary, installed: !!found, ...(found ? { version: found.version } : {}) };
    }));
}

/** Claude Code's answer: a stream of JSON events (the final `result` one carries the text and cost), or one JSON object from older runs. */
function claudeAnswer(stdout: string): { text: string } & Spend {
    const events = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{')).flatMap(line => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
    const result = events.filter(e => e?.type === 'result').at(-1) ?? (events.length === 1 ? events[0] : undefined);
    if (!result) return { text: stdout };
    const usage = result.usage;
    const trace = traceOf(events);
    return {
        text: String(result.result ?? ''),
        ...(typeof result.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd } : {}),
        ...(usage ? { tokens: { input: n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens), output: n(usage.output_tokens) } } : {}),
        ...(trace ? { trace } : {}),
    };
}

/** The turns, their usage and the tool calls of a stream, or undefined for a single-object answer. */
function traceOf(events: any[]): RunTrace | undefined {
    const assistant = events.filter(e => e?.type === 'assistant' && e.message);
    if (assistant.length === 0) return undefined;
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    const calls: RunTrace['calls'] = [];
    const byId = new Map<string, RunTrace['calls'][number]>();
    let turn = 0;
    const seen = new Set<string>();
    for (const e of events) {
        if (e?.type === 'assistant' && e.message) {
            // One model call can arrive as several events (one per content block) sharing its id: count its usage once.
            const id = String(e.message.id ?? `turn-${turn}`);
            if (!seen.has(id)) {
                seen.add(id);
                turn++;
                const u = e.message.usage ?? {};
                usage.input += n(u.input_tokens);
                usage.cacheRead += n(u.cache_read_input_tokens);
                usage.cacheWrite += n(u.cache_creation_input_tokens);
                usage.output += n(u.output_tokens);
            }
            for (const block of e.message.content ?? []) {
                if (block?.type !== 'tool_use') continue;
                const input = block.input ?? {};
                const call = { turn, tool: String(block.name ?? ''), target: String(input.file_path ?? input.path ?? input.pattern ?? input.command ?? '').slice(0, 300), resultChars: 0 };
                calls.push(call);
                byId.set(String(block.id), call);
            }
        } else if (e?.type === 'user' && e.message) {
            for (const block of e.message.content ?? []) {
                if (block?.type !== 'tool_result') continue;
                const call = byId.get(String(block.tool_use_id));
                if (!call) continue;
                const content = block.content;
                call.resultChars = typeof content === 'string' ? content.length : Array.isArray(content) ? content.reduce((sum: number, c: any) => sum + String(c?.text ?? '').length, 0) : 0;
            }
        }
    }
    return { turns: turn, usage, calls };
}
