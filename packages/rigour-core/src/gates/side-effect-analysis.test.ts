import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SideEffectAnalysisGate } from './side-effect-analysis/index.js';

describe('SideEffectAnalysisGate', () => {
    let cwd: string;
    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'side-effect-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    async function titlesFor(file: string, source: string): Promise<string[]> {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), source);
        const failures = await new SideEffectAnalysisGate().run({ cwd });
        return failures.map(f => f.title);
    }

    describe('process spawns', () => {
        it('does not treat RegExp.prototype.exec as a process spawn', async () => {
            // Verbatim shape of the SvelteKit repo's scripts/lint-fonts.mjs.
            const titles = await titlesFor('scripts/lint-fonts.mjs', [
                'function checkFontFamilyDeclarations(file, source) {',
                '\tconst findings = [];',
                '\tconst re = /font-family\\s*:/gi;',
                '\tlet match;',
                '\twhile ((match = re.exec(source)) !== null) {',
                '\t\tconst valueStart = match.index + match[0].length;',
                '\t\tfindings.push({ file, valueStart });',
                '\t}',
                '\treturn findings;',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(false);
        });

        it('does not treat a database exec method as a process spawn', async () => {
            const titles = await titlesFor('src/db.ts', "export function migrate(db: any) { db.exec('create table t (id int)'); }\n");
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(false);
        });

        it('does not flag a synchronous execFileSync call', async () => {
            const titles = await titlesFor('scripts/eval/run.ts', [
                "import { execFileSync } from 'node:child_process';",
                "export const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(false);
        });

        it('accepts once("exit") as exit handling for a spawned process', async () => {
            const titles = await titlesFor('scripts/upload.ts', [
                "import { spawn } from 'node:child_process';",
                'export async function upload(args: string[]) {',
                '  const code = await new Promise<number>((resolve, reject) => {',
                "    const child = spawn('npx', args, { stdio: 'inherit' });",
                "    child.once('error', reject);",
                "    child.once('exit', (c) => resolve(c ?? 1));",
                '  });',
                '  return code;',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(false);
        });

        it('does not read prose in a comment as a fork call', async () => {
            const titles = await titlesFor('src/lib/seo/json-ld.ts', [
                "// Canonical profiles, ported as data from the fork (verified against production).",
                'export const profiles = [];',
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(false);
        });

        it('still flags a child_process exec whose process is never handled', async () => {
            const titles = await titlesFor('src/run.ts', [
                "import { exec } from 'child_process';",
                'export function run() {',
                "  exec('ls -la');",
                '}',
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(true);
        });

        it('still flags a spawn through a child_process namespace', async () => {
            const titles = await titlesFor('src/run.ts', [
                "import * as cp from 'node:child_process';",
                'export function run() {',
                "  cp.spawn('node', ['worker.js']);",
                '}',
            ].join('\n'));
            expect(titles.some(t => /Orphan Process/.test(t))).toBe(true);
        });
    });

    describe('timers', () => {
        it('does not flag a one-shot awaited setTimeout delay', async () => {
            const titles = await titlesFor('scripts/deploy.ts', [
                'export async function retry(attempt: number) {',
                '  await new Promise((resolve) => setTimeout(resolve, attempt * 250));',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Unbounded Timer/.test(t))).toBe(false);
        });

        it('pairs a timer kept on a private field with a clearInterval in another method', async () => {
            const titles = await titlesFor('src/lib/review-state.svelte.ts', [
                'export class ReviewState {',
                '  #progressTimer: ReturnType<typeof setInterval> | undefined;',
                '  start() {',
                '    this.#progressTimer = setInterval(() => this.tick(), 500);',
                '  }',
                '  stop() {',
                '    clearInterval(this.#progressTimer);',
                '  }',
                '  tick() {}',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Unbounded Timer/.test(t))).toBe(false);
        });

        it('pairs a timer kept in an outer variable with a clearInterval in another function', async () => {
            const titles = await titlesFor('src/lib/poller.ts', [
                'let pollTimer: ReturnType<typeof setInterval> | undefined;',
                'export function startPolling(refresh: () => void) {',
                '  pollTimer = setInterval(refresh, 5000);',
                '}',
                'export function stopPolling() {',
                '  clearInterval(pollTimer);',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Unbounded Timer/.test(t))).toBe(false);
        });

        it('still flags a local interval whose own function never clears it', async () => {
            const titles = await titlesFor('src/lib/leak.ts', [
                'export function start(refresh: () => void) {',
                '  const timer = setInterval(refresh, 5000);',
                '  return 1;',
                '}',
                'export function stop(other: ReturnType<typeof setInterval>) {',
                '  clearInterval(other);',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Unbounded Timer/.test(t))).toBe(true);
        });

        it('still flags a setInterval that is never cleared', async () => {
            const titles = await titlesFor('src/poll.ts', [
                'export function poll(check: () => void) {',
                '  setInterval(check, 1000);',
                '}',
            ].join('\n'));
            expect(titles.some(t => /Unbounded Timer/.test(t))).toBe(true);
        });
    });
});
