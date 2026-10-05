/**
 * The repository's own tools, run on what a change touched: the formatter, the linter, the type
 * checker and the tests that import changed files. Teams already trust these; Rigour runs them at
 * the moment that matters (before a push) so nobody has to remember. Only tools the project
 * installed are run (node_modules/.bin, never a download); a missing one is reported as skipped.
 * A tool configured under `commands:` is left to that command, which every review already runs.
 */
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import type { Config } from '../types/index.js';
import { installedBin } from '../utils/installed-bin.js';

export type ToolStatus = 'pass' | 'fail' | 'skipped';

export interface ToolResult {
    tool: 'format' | 'lint' | 'typecheck' | 'test';
    status: ToolStatus;
    /** The command run, or why it was not. */
    command: string;
    /** The tail of the output when it failed. */
    output?: string;
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const FORMATTED = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|json|css|md|ya?ml|html)$/;
/** Long file lists are split so a command line stays under Windows' limit. */
const BATCH = 150;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LINES = 30;

export async function runToolchain(cwd: string, changedFiles: string[], config: Config): Promise<ToolResult[]> {
    const files = changedFiles.filter(file => fs.existsSync(path.join(cwd, file)));
    const code = files.filter(file => CODE.test(file));
    const configured = config.commands ?? {};
    const results: ToolResult[] = [];
    const run = async (tool: ToolResult['tool'], step: () => Promise<ToolResult>) => {
        results.push(configured[tool] ? { tool, status: 'skipped', command: `commands.${tool} runs it` } : await step());
    };
    await run('format', () => formatCheck(cwd, files.filter(file => FORMATTED.test(file))));
    await run('lint', () => lint(cwd, code));
    await run('typecheck', () => typecheck(cwd));
    await run('test', () => relatedTests(cwd, code));
    return results;
}

async function formatCheck(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'prettier');
    if (!bin) return skipped('format', 'prettier is not installed');
    if (files.length === 0) return { tool: 'format', status: 'pass', command: 'no files to format' };
    return batched('format', cwd, bin, ['--check', '--ignore-unknown'], files);
}

async function lint(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'eslint');
    if (!bin) return skipped('lint', 'eslint is not installed');
    if (files.length === 0) return { tool: 'lint', status: 'pass', command: 'no code files' };
    // ESLint 9 warns about an explicitly named ignored file, which --max-warnings=0 would count.
    const quietIgnored = (await majorVersion(cwd, bin)) >= 9 ? ['--no-warn-ignored'] : [];
    return batched('lint', cwd, bin, ['--max-warnings=0', ...quietIgnored], files);
}

async function typecheck(cwd: string): Promise<ToolResult> {
    const svelte = fs.readdirSync(cwd).some(name => /^svelte\.config\./.test(name)) && installedBin(cwd, cwd, 'svelte-check');
    if (svelte) return once('typecheck', cwd, svelte, ['--threshold', 'error', '--output', 'machine']);
    const tsc = fs.existsSync(path.join(cwd, 'tsconfig.json')) && installedBin(cwd, cwd, 'tsc');
    if (tsc) return once('typecheck', cwd, tsc, ['--noEmit']);
    return skipped('typecheck', 'no svelte-check or tsc with a tsconfig.json');
}

/** Tests that import a changed file; a file that fails in the parallel run is run again alone, so a timing flake passes. */
async function relatedTests(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'vitest');
    if (!bin) return skipped('test', 'vitest is not installed');
    if (files.length === 0) return { tool: 'test', status: 'pass', command: 'no code files' };
    const first = await once('test', cwd, bin, ['related', '--run', '--passWithNoTests', ...files]);
    if (first.status === 'pass') return first;
    const failed = [...new Set([...(first.output ?? '').matchAll(/FAIL\s+(?:\|[^|]+\|\s+)?([^\s>:]+\.(?:test|spec)\.[a-z.]+)/g)].map(m => m[1]))];
    if (failed.length === 0) return first;
    const again = await once('test', cwd, bin, ['run', ...failed]);
    return again.status === 'pass' ? { ...again, command: `${first.command} (flaky files passed alone: ${failed.join(', ')})` } : again;
}

async function batched(tool: ToolResult['tool'], cwd: string, bin: string, args: string[], files: string[]): Promise<ToolResult> {
    for (let i = 0; i < files.length; i += BATCH) {
        const result = await once(tool, cwd, bin, [...args, ...files.slice(i, i + BATCH)]);
        if (result.status !== 'pass') return result;
    }
    return { tool, status: 'pass', command: `${path.basename(bin)} ${args.join(' ')} (${files.length} files)` };
}

async function once(tool: ToolResult['tool'], cwd: string, bin: string, args: string[]): Promise<ToolResult> {
    const command = `${path.basename(bin)} ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}`;
    const result = await execa(bin, args, { cwd, reject: false, timeout: TIMEOUT_MS, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    if (result.exitCode === 0 && !result.timedOut) return { tool, status: 'pass', command };
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-OUTPUT_LINES).join('\n');
    return { tool, status: 'fail', command, output: result.timedOut ? `timed out after ${TIMEOUT_MS / 60_000} minutes\n${output}` : output };
}

async function majorVersion(cwd: string, bin: string): Promise<number> {
    const result = await execa(bin, ['--version'], { cwd, reject: false, timeout: 30_000 });
    return Number(String(result.stdout).match(/(\d+)\./)?.[1] ?? 0);
}

function skipped(tool: ToolResult['tool'], why: string): ToolResult {
    return { tool, status: 'skipped', command: why };
}
