/**
 * Read-only repository tools for an agentic review.
 *
 * A reviewer that can only see the chunk it was sent guesses about callers,
 * callees and types; one that can look them up checks its suspicion first.
 * These tools only read, only inside the repository, never secrets files,
 * and record which lines of which files the model actually read so its
 * findings can still be grounded (code-verifier.ts).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { ChatTool, ToolCall } from '../inference/types.js';

const MAX_READ_LINES = 200;
const MAX_GREP_LINES = 40;
const MAX_LINE_CHARS = 240;
/** Never sent to a model provider: environment files, keys, credentials. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|\.npmrc|\.netrc|credentials(\.json)?)$/i;

export const REVIEW_TOOLS: ChatTool[] = [
    {
        name: 'read_file',
        description: 'Read lines of a repository file, numbered. Use it to check callers, callees, types and constants before claiming a defect.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repository-relative path.' },
                start_line: { type: 'integer', description: 'First line, 1-based (default 1).' },
                end_line: { type: 'integer', description: `Last line (at most ${MAX_READ_LINES} lines per call).` },
            },
            required: ['path'],
        },
    },
    {
        name: 'grep',
        description: 'Search tracked files with an extended regular expression. Returns path:line:text matches.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string' },
                path_glob: { type: 'string', description: 'Optional pathspec, e.g. "src/**/*.ts".' },
            },
            required: ['pattern'],
        },
    },
];

/** Tools bound to one repository, remembering what was read. */
export class ReviewToolbox {
    /** Repository-relative path → [start, end] line ranges the model read. */
    readonly reads = new Map<string, Array<[number, number]>>();
    /** Text the model read, for checking identifiers it cites. */
    readText = '';

    constructor(private readonly cwd: string) {}

    run(call: ToolCall): string {
        try {
            if (call.name === 'read_file') return this.readFile(call.arguments);
            if (call.name === 'grep') return this.grep(call.arguments);
            return `Unknown tool "${call.name}".`;
        } catch (error: any) {
            return `Error: ${error?.message ?? String(error)}`;
        }
    }

    private readFile(args: Record<string, unknown>): string {
        const file = this.inside(String(args.path ?? ''));
        const lines = fs.readFileSync(path.join(this.cwd, file), 'utf-8').split('\n');
        const start = clamp(Number(args.start_line) || 1, 1, lines.length);
        const end = clamp(Number(args.end_line) || start + MAX_READ_LINES - 1, start, Math.min(lines.length, start + MAX_READ_LINES - 1));
        const text = lines.slice(start - 1, end).map((line, i) => `${String(start + i).padStart(5)}| ${line}`).join('\n');
        this.reads.set(file, [...(this.reads.get(file) ?? []), [start, end]]);
        this.readText += `\n${lines.slice(start - 1, end).join('\n')}`;
        return `${file} lines ${start}-${end} of ${lines.length}:\n${text}`;
    }

    private grep(args: Record<string, unknown>): string {
        const pattern = String(args.pattern ?? '');
        if (!pattern || pattern.length > 200) return 'Error: pattern must be 1-200 characters.';
        const spec = typeof args.path_glob === 'string' && args.path_glob ? [args.path_glob] : [];
        let out = '';
        try {
            out = execFileSync('git', ['grep', '-n', '-I', '-E', '-e', pattern, '--', ...spec], {
                cwd: this.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
            });
        } catch {
            return 'No matches.';
        }
        const matches = out.split('\n').filter(line => line && !SECRET_FILE.test(line.split(':')[0]));
        const shown = matches.slice(0, MAX_GREP_LINES).map(line => line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
        this.readText += `\n${shown.join('\n')}`;
        return shown.length ? shown.join('\n') + (matches.length > shown.length ? `\n… ${matches.length - shown.length} more` : '') : 'No matches.';
    }

    /** A repository-relative path that stays inside the repository and is not a secrets file. */
    private inside(requested: string): string {
        const root = fs.realpathSync(this.cwd);
        const resolved = fs.realpathSync(path.resolve(root, requested));
        const relative = path.relative(root, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path is outside the repository');
        const posix = relative.split(path.sep).join('/');
        if (posix.startsWith('.git/') || SECRET_FILE.test(posix)) throw new Error('this file is not readable by the reviewer');
        return posix;
    }
}

function clamp(value: number, low: number, high: number): number {
    return Math.max(low, Math.min(high, Math.floor(value)));
}
