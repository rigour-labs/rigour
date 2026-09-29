/**
 * Process runner and argument builder for llama-cli (llama.cpp b5604).
 *
 * Flags verified against b5604:
 * - `-st` applies the model's chat template for one turn, then exits. Without
 *   it an instruct model starts an interactive chat and waits on stdin;
 *   `-no-cnv` avoids that but treats the prompt as raw text to continue.
 * - `--json-schema-file` constrains output to the findings schema. There is
 *   no `--json` flag; b5604 rejects it.
 * - `--log-disable` is NOT used: in b5604 it also suppresses the generated
 *   text, so stdout comes back empty.
 * - `--seed` is fixed: llama.cpp otherwise draws a random seed per run, so
 *   the same file could pass one CI run and fail the next.
 */
import { spawn } from 'child_process';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MIN_CONTEXT = 4096;
const MAX_CONTEXT = 32768;
/** Conservative characters-per-token for code and JSON-ish prompts. */
const CHARS_PER_TOKEN = 3;
const FIXED_SEED = 42;

export interface ProcessResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export interface RunProcessOptions {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
}

export class ProcessTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`timed out after ${timeoutMs / 1000}s`);
        this.name = 'ProcessTimeoutError';
    }
}

/**
 * Run a binary with stdin closed, collecting stdout/stderr. Rejects on spawn
 * errors and timeouts; a non-zero exit resolves with its code.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessResult> {
    const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const [bin, argv] = isWindowsScript
        ? ['cmd.exe', ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')]]
        : [command, args];

    return new Promise((resolve, reject) => {
        const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: options.env, windowsHide: true });
        const stdout = new BoundedBuffer();
        const stderr = new BoundedBuffer();
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new ProcessTimeoutError(options.timeoutMs));
        }, options.timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        });
    });
}

class BoundedBuffer {
    private chunks: Buffer[] = [];
    private size = 0;

    push(chunk: Buffer): void {
        if (this.size >= MAX_OUTPUT_BYTES) return;
        this.chunks.push(chunk);
        this.size += chunk.length;
    }

    toString(): string {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

function quoteCmdArg(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

export interface LlamaArgsInput {
    modelPath: string;
    prompt: string;
    maxTokens: number;
    threads: number;
    temperature: number;
    schemaPath?: string;
}

export function buildLlamaArgs(input: LlamaArgsInput): string[] {
    const args = [
        '--model', input.modelPath,
        '--prompt', input.prompt,
        '--n-predict', String(input.maxTokens),
        '--threads', String(input.threads),
        '--temp', String(input.temperature),
        '--seed', String(FIXED_SEED),
        '--ctx-size', String(contextSizeFor(input.prompt, input.maxTokens)),
        '--no-display-prompt',
        '-st',
        '--simple-io',
    ];
    if (input.schemaPath) args.push('--json-schema-file', input.schemaPath);
    return args;
}

/**
 * Context window large enough for prompt + output, rounded up to 1024 and
 * clamped to what Qwen2.5-Coder was trained on. The b5604 default is 4096,
 * which silently truncates code-bearing prompts.
 */
export function contextSizeFor(prompt: string, maxTokens: number): number {
    const needed = Math.ceil(prompt.length / CHARS_PER_TOKEN) + maxTokens + 256;
    const rounded = Math.ceil(needed / 1024) * 1024;
    return Math.min(MAX_CONTEXT, Math.max(MIN_CONTEXT, rounded));
}

/** Remove llama-cli's end-of-generation marker from stdout. */
export function cleanLlamaOutput(stdout: string): string {
    return stdout.replace(/\s*\[end of text\]\s*$/, '').trim();
}

/** JSON schema matching DeepFinding, used to constrain local generation. */
export const FINDINGS_JSON_SCHEMA = {
    type: 'object',
    properties: {
        findings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    category: { type: 'string' },
                    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
                    file: { type: 'string' },
                    line: { type: ['integer', 'null'] },
                    description: { type: 'string' },
                    suggestion: { type: 'string' },
                    confidence: { type: 'number' },
                },
                required: ['category', 'severity', 'file', 'description', 'suggestion', 'confidence'],
            },
        },
    },
    required: ['findings'],
} as const;
