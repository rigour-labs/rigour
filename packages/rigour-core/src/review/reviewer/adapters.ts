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

export type ReviewerName = 'claude' | 'cursor' | 'codex';
export type Vendor = 'anthropic' | 'cursor' | 'openai';
export type ReviewMode = 'single' | 'cross' | 'full';

export interface Adapter {
    vendor: Vendor;
    binary: string;
    /** The command line for one review: the prompt is passed as text, never through a shell. */
    args(prompt: string, model: string | undefined): string[];
    /** The reviewer's final message and, when the CLI reports it, what the run cost. */
    answer(stdout: string): { text: string; costUsd?: number };
}

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
            '--output-format', 'json',
            '--max-turns', '80',
            '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
            '--setting-sources', 'project', '--settings', '{"hooks":{},"outputStyle":"default"}',
            '--allowedTools', ...READ_ONLY_TOOLS,
            '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash(git push:*)', 'Bash(git commit:*)',
        ],
        answer: stdout => {
            try {
                const parsed = JSON.parse(stdout);
                return { text: String(parsed.result ?? ''), ...(typeof parsed.total_cost_usd === 'number' ? { costUsd: parsed.total_cost_usd } : {}) };
            } catch {
                return { text: stdout };
            }
        },
    },
    cursor: {
        vendor: 'cursor',
        binary: 'cursor-agent',
        // Ask mode is read-only and cannot run git: every input the prompt names is a file.
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
        args: (prompt, model) => ['exec', '--sandbox', 'read-only', '--json', ...(model ? ['--model', model] : []), '-c', 'model_reasoning_effort=high', prompt],
        // `codex exec --json` streams events; the last text-bearing one carries the answer.
        answer: stdout => {
            let text = '';
            for (const line of stdout.split('\n').filter(Boolean)) {
                try {
                    const event = JSON.parse(line);
                    const candidate = event?.item?.text ?? event?.msg?.message ?? event?.text;
                    if (typeof candidate === 'string') text = candidate;
                } catch {
                    // not an event line
                }
            }
            return { text: text || stdout };
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
export function selectReviewers(candidates: ReviewerName[], mode: ReviewMode, authors: Set<Vendor>, available: Set<ReviewerName>, judges = 2): ReviewerName[] {
    const installed = candidates.filter(name => available.has(name));
    if (installed.length === 0) return [];
    let first = installed[0];
    if (mode !== 'single') first = installed.find(name => !authors.has(ADAPTERS[name].vendor)) ?? first;
    if (mode !== 'full') return [first];
    const chosen = [first];
    for (const name of installed) {
        if (chosen.length >= judges) break;
        if (!chosen.some(c => ADAPTERS[c].vendor === ADAPTERS[name].vendor)) chosen.push(name);
    }
    return chosen;
}

/** Every reviewer Rigour can run, and whether this machine has it: what bounds the judges of a panel. */
export async function reviewerAvailability(cwd: string, exec: Exec = defaultExec): Promise<Array<{ name: ReviewerName; vendor: Vendor; binary: string; installed: boolean; version?: string }>> {
    return Promise.all((Object.keys(ADAPTERS) as ReviewerName[]).map(async name => {
        const found = await resolveAdapter(ADAPTERS[name], cwd, exec);
        return { name, vendor: ADAPTERS[name].vendor, binary: ADAPTERS[name].binary, installed: !!found, ...(found ? { version: found.version } : {}) };
    }));
}
