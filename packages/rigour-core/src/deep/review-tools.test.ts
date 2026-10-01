import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReviewToolbox } from './review-tools.js';

let repo: string;
const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, arguments: args });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-tools-'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/a.ts'), Array.from({ length: 300 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n'));
    fs.writeFileSync(path.join(repo, '.env'), 'API_KEY=secret');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('ReviewToolbox', () => {
    it('reads numbered lines, caps a call at 200 lines, and records what was read', () => {
        const tools = new ReviewToolbox(repo);
        const out = tools.run(call('read_file', { path: 'src/a.ts', start_line: 10, end_line: 900 }));
        expect(out).toContain('src/a.ts lines 10-209 of 300');
        expect(out).toContain('   10| const v10 = 10;');
        expect(tools.reads.get('src/a.ts')).toEqual([[10, 209]]);
        expect(tools.readText).toContain('const v209');
    });

    it('refuses paths outside the repository and secrets files, without throwing', () => {
        const tools = new ReviewToolbox(repo);
        expect(tools.run(call('read_file', { path: '../../etc/passwd' }))).toMatch(/^Error:/);
        expect(tools.run(call('read_file', { path: '.env' }))).toBe('Error: this file is not readable by the reviewer');
        expect(tools.reads.size).toBe(0);
    });

    it('greps tracked files but never shows a secrets file', () => {
        const tools = new ReviewToolbox(repo);
        expect(tools.run(call('grep', { pattern: 'v12 =' }))).toBe('src/a.ts:12:const v12 = 12;');
        expect(tools.run(call('grep', { pattern: 'API_KEY' }))).toBe('No matches.');
        expect(tools.run(call('shell', {}))).toBe('Unknown tool "shell".');
    });
});
