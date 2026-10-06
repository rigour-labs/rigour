/**
 * The repository's own tools, run on what a change touched: the formatter, the linter, the type
 * checker and the tests that import changed files. Teams already trust these; Rigour runs them at
 * the moment that matters (before a push) so nobody has to remember. Only tools the project
 * installed are run (node_modules/.bin, never a download). A tool the project never declared is
 * skipped and said so; one declared in package.json but not installed FAILS, since a checkout
 * without its dependencies cannot prove anything about the change. A tool configured under
 * `commands:` is left to that command, which every review already runs.
 */
import { execa } from 'execa';
import fs from 'fs';
import path from 'path';
import type { Config } from '../types/index.js';
import { installedBin } from '../utils/installed-bin.js';
import { onChangedLines, overlayUnavailable, writeOverlayConfig } from './lint-overlay.js';
import { ownOutputs } from './unused-exports.js';

export type ToolStatus = 'pass' | 'fail' | 'skipped';

export interface ToolResult {
    tool: 'format' | 'lint' | 'overlay' | 'typecheck' | 'test' | 'knip';
    status: ToolStatus;
    /** The command run, or why it was not. */
    command: string;
    /** The tail of the output when it failed. */
    output?: string;
    /** One line per finding, for tools that report places (the lint overlay, knip). */
    lines?: string[];
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|svelte)$/;
const FORMATTED = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|json|css|md|ya?ml|html)$/;
/** Long file lists are split so a command line stays under Windows' limit. */
const BATCH = 150;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LINES = 30;

/** `changedLines`: the lines the change touched, for the tools that report per line (the overlay blocks on those only). */
export async function runToolchain(cwd: string, changedFiles: string[], config: Config, changedLines: Record<string, Set<number>> = {}): Promise<ToolResult[]> {
    const own = ownOutputs(config);
    const files = changedFiles.filter(file => !own.some(o => file === o || file.startsWith(`${o}/`)) && fs.existsSync(path.join(cwd, file)));
    const code = files.filter(file => CODE.test(file));
    const configured: Record<string, string | undefined> = config.commands ?? {};
    const results: ToolResult[] = [];
    const run = async (tool: ToolResult['tool'], step: () => Promise<ToolResult>) => {
        results.push(configured[tool] ? { tool, status: 'skipped', command: `commands.${tool} runs it` } : await step());
    };
    await run('format', () => formatCheck(cwd, files.filter(file => FORMATTED.test(file))));
    await run('lint', () => lint(cwd, code));
    await run('overlay', () => lintOverlay(cwd, code, changedLines));
    await run('typecheck', () => typecheck(cwd));
    await run('test', () => relatedTests(cwd, code));
    await run('knip', () => knip(cwd, files));
    return results;
}

/**
 * Type-checked rules the repository does not enable (lint-overlay.ts), on changed lines only. The
 * repository's own eslint and typescript-eslint run it; without them it is skipped and said so.
 */
async function lintOverlay(cwd: string, files: string[], changedLines: Record<string, Set<number>>): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'eslint');
    if (!bin) return skipped('overlay', 'eslint is not installed');
    const unavailable = overlayUnavailable(cwd);
    if (unavailable) return skipped('overlay', unavailable);
    const lintable = files.filter(file => /\.(ts|mts|cts|js|mjs|svelte)$/.test(file));
    if (lintable.length === 0) return { tool: 'overlay', status: 'pass', command: 'no lintable changed files' };
    const configFile = writeOverlayConfig(cwd);
    try {
        const command = `eslint --config <typed overlay> --format json (${lintable.length} files)`;
        const result = await execa(bin, ['--config', configFile, '--no-warn-ignored', '--format', 'json', ...lintable], { cwd, reject: false, timeout: TIMEOUT_MS, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
        const report = onChangedLines(String(result.stdout ?? ''), cwd, changedLines);
        if ('error' in report) return { tool: 'overlay', status: 'fail', command, output: `${report.error}\n${String(result.stderr ?? '').trim().split('\n').slice(-OUTPUT_LINES).join('\n')}` };
        const lines = report.blocking.map(m => `${m.file}:${m.line}:${m.column} ${m.rule}: ${m.message}`);
        const summary = `${command}: ${lines.length} on changed lines, ${report.preexisting} pre-existing (not blocking)`;
        return lines.length ? { tool: 'overlay', status: 'fail', command: summary, output: lines.join('\n'), lines } : { tool: 'overlay', status: 'pass', command: summary };
    } finally {
        fs.rmSync(path.dirname(configFile), { recursive: true, force: true });
    }
}

/**
 * knip, when the repository installs it, with the repository's own config: unused files and
 * exports among the files the change touched (a pre-existing dead export elsewhere is backlog).
 */
async function knip(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'knip');
    if (!bin) return notInstalled('knip', cwd, 'knip');
    if (files.length === 0) return { tool: 'knip', status: 'pass', command: 'no changed files' };
    const command = 'knip --production --reporter json';
    const result = await execa(bin, ['--production', '--no-progress', '--reporter', 'json'], { cwd, reject: false, timeout: TIMEOUT_MS, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let report: { files?: string[]; issues?: Array<{ file: string; exports?: Array<{ name: string; line?: number }>; types?: Array<{ name: string; line?: number }> }> };
    try {
        report = JSON.parse(String(result.stdout ?? ''));
    } catch {
        return { tool: 'knip', status: 'fail', command, output: `knip printed no JSON (exit ${result.exitCode})\n${String(result.stderr ?? '').trim().split('\n').slice(-OUTPUT_LINES).join('\n')}` };
    }
    const changed = new Set(files);
    const normalize = (file: string) => path.isAbsolute(file) ? path.relative(cwd, file).split(path.sep).join('/') : file;
    const lines = [
        ...(report.files ?? []).map(normalize).filter(file => changed.has(file)).map(file => `${file}: nothing imports or runs this file`),
        ...(report.issues ?? []).filter(issue => changed.has(normalize(issue.file))).flatMap(issue =>
            [...(issue.exports ?? []), ...(issue.types ?? [])].map(e => `${normalize(issue.file)}${e.line ? `:${e.line}` : ''}: unused export ${e.name}`)),
    ];
    return lines.length ? { tool: 'knip', status: 'fail', command: `${command}: ${lines.length} in changed files`, output: lines.join('\n'), lines } : { tool: 'knip', status: 'pass', command };
}

async function formatCheck(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'prettier');
    if (!bin) return notInstalled('format', cwd, 'prettier');
    if (files.length === 0) return { tool: 'format', status: 'pass', command: 'no files to format' };
    return batched('format', cwd, bin, ['--check', '--ignore-unknown'], files);
}

async function lint(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'eslint');
    if (!bin) return notInstalled('lint', cwd, 'eslint');
    if (files.length === 0) return { tool: 'lint', status: 'pass', command: 'no code files' };
    // ESLint 9 warns about an explicitly named ignored file, which --max-warnings=0 would count.
    const quietIgnored = (await majorVersion(cwd, bin)) >= 9 ? ['--no-warn-ignored'] : [];
    return batched('lint', cwd, bin, ['--max-warnings=0', ...quietIgnored], files);
}

/**
 * The project's own type check when it has one (a `typecheck` or `check` script: teams put the
 * right command there, e.g. generating SvelteKit's types first); else svelte-check after
 * `svelte-kit sync` when svelte-check is installed (found by its binary, not by a config file a
 * SvelteKit project may not have); else tsc. A type check covers the whole project.
 */
async function typecheck(cwd: string): Promise<ToolResult> {
    const pkg = readPackage(cwd);
    const script = ['typecheck', 'check'].find(name => typeof pkg.scripts?.[name] === 'string');
    if (script) return once('typecheck', cwd, process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', script]);
    const svelteCheck = installedBin(cwd, cwd, 'svelte-check');
    if (svelteCheck) {
        // SvelteKit's generated types must exist first; a plain Svelte project has no svelte-kit binary.
        const kit = installedBin(cwd, cwd, 'svelte-kit');
        if (kit) await once('typecheck', cwd, kit, ['sync']);
        return once('typecheck', cwd, svelteCheck, ['--threshold', 'error', '--output', 'machine']);
    }
    const tsc = fs.existsSync(path.join(cwd, 'tsconfig.json')) && installedBin(cwd, cwd, 'tsc');
    if (tsc) return once('typecheck', cwd, tsc, ['--noEmit']);
    for (const pkg of ['svelte-check', 'typescript']) if (declared(cwd, pkg)) return notInstalled('typecheck', cwd, pkg);
    return skipped('typecheck', 'no typecheck/check script, svelte-check or tsc with a tsconfig.json');
}

function declared(cwd: string, pkg: string): boolean {
    const manifest = readPackage(cwd);
    return !!(manifest.dependencies?.[pkg] ?? manifest.devDependencies?.[pkg]);
}

/** Declared in package.json but absent from node_modules: a checkout that cannot prove anything fails; a tool never declared is skipped. */
function notInstalled(tool: ToolResult['tool'], cwd: string, pkg: string): ToolResult {
    return declared(cwd, pkg)
        ? { tool, status: 'fail', command: `${pkg} is in package.json but not installed`, output: `node_modules has no ${pkg}: install the dependencies (npm install, pnpm install, …) and run again` }
        : skipped(tool, `${pkg} is not installed`);
}

function readPackage(cwd: string): { scripts?: Record<string, unknown>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
    try {
        return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    } catch {
        return {};
    }
}

/** Tests that import a changed file; a file that fails in the parallel run is run again alone, so a timing flake passes. */
async function relatedTests(cwd: string, files: string[]): Promise<ToolResult> {
    const bin = installedBin(cwd, cwd, 'vitest');
    if (!bin) return notInstalled('test', cwd, 'vitest');
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
    return { tool, status: 'pass', command: `${programName(bin)} ${args.join(' ')} (${files.length} files)` };
}

async function once(tool: ToolResult['tool'], cwd: string, bin: string, args: string[]): Promise<ToolResult> {
    const command = `${programName(bin)} ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}`;
    const result = await execa(bin, args, { cwd, reject: false, timeout: TIMEOUT_MS, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    if (result.exitCode === 0 && !result.timedOut) return { tool, status: 'pass', command };
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-OUTPUT_LINES).join('\n');
    return { tool, status: 'fail', command, output: result.timedOut ? `timed out after ${TIMEOUT_MS / 60_000} minutes\n${output}` : output };
}

async function majorVersion(cwd: string, bin: string): Promise<number> {
    const result = await execa(bin, ['--version'], { cwd, reject: false, timeout: 30_000 });
    return Number(String(result.stdout).match(/(\d+)\./)?.[1] ?? 0);
}

/** The program as a person types it: `prettier`, not `prettier.cmd` (a Windows shim). */
function programName(bin: string): string {
    return path.basename(bin).replace(/\.(cmd|exe|bat)$/i, '');
}

function skipped(tool: ToolResult['tool'], why: string): ToolResult {
    return { tool, status: 'skipped', command: why };
}
