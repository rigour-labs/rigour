import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { fileSizeFailures } from './file-size.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}`).join('\n');
const write = (file: string, n: number) => fs.writeFileSync(path.join(repo, file), lines(n));
const config = (block?: boolean) => ConfigSchema.parse({ version: 1, gates: { max_file_lines: 500, ...(block === undefined ? {} : { file_size: { block } }) } });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'file-size-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('near.ts', 495);
    write('big.ts', 600);
    git('add', '-A');
    git('commit', '-qm', 'base');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('a file the change took over the size limit', () => {
    it('is a finding only for a crossing or a new long file: a note by default, proven when the team opts in', () => {
        const base = git('rev-parse', 'HEAD');
        write('near.ts', 505);
        write('big.ts', 610);
        write('new.ts', 675);
        const changed = { 'near.ts': new Set([496]), 'big.ts': new Set([601]), 'new.ts': new Set([1]) };
        const noted = fileSizeFailures(repo, changed, base, config());
        expect(noted.map(f => [f.files?.[0], f.line, f.certainty])).toEqual([['near.ts', 496, 'likely'], ['new.ts', 1, 'likely']]);
        expect(noted[0].details).toContain('from 495 to 505 lines');
        expect(fileSizeFailures(repo, changed, base, config(true)).map(f => f.certainty)).toEqual(['proven', 'proven']);
    });

    it('is never guessed without a base, and never raised for a file the change shrinks', () => {
        write('new.ts', 675);
        expect(fileSizeFailures(repo, { 'new.ts': new Set([1]) }, undefined, config(true))).toEqual([]);
        write('big.ts', 590);
        expect(fileSizeFailures(repo, { 'big.ts': new Set([10]) }, git('rev-parse', 'HEAD'), config(true))).toEqual([]);
    });
});
