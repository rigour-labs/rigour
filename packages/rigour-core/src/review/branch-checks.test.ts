import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { mergeConflicts, staleReferences } from './branch-checks.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const config = ConfigSchema.parse({ version: 1 });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-checks-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('src/limits.ts', 'export const LIMIT = 1;\n');
    write('scripts/seed.ts', 'console.log(1);\n');
    write('scripts/seed.tsx', 'console.log(2);\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('branch checks', () => {
    it('reports the files that conflict with main, and nothing when it merges cleanly', () => {
        git('checkout', '-q', '-b', 'feature');
        write('src/limits.ts', 'export const LIMIT = 2;\n');
        git('commit', '-qam', 'feature');
        expect(mergeConflicts(repo, 'main')).toEqual([]);
        git('checkout', '-q', 'main');
        write('src/limits.ts', 'export const LIMIT = 3;\n');
        git('commit', '-qam', 'main moved');
        git('checkout', '-q', 'feature');
        expect(mergeConflicts(repo, 'main').map(f => [f.id, f.files?.[0]])).toEqual([['merge-conflict', 'src/limits.ts']]);
    });

    it('reports a mention of a file the branch deleted, but not of a longer path that starts with it', () => {
        const base = git('rev-parse', 'HEAD').trim();
        git('rm', '-q', 'scripts/seed.ts');
        write('README.md', 'Run `scripts/seed.ts` first.\nThen scripts/seed.tsx.\n');
        write('src/notes.ts', '// see scripts/seed.tsx\nexport const n = 1;\n');
        const found = staleReferences(repo, base, config).map(f => [f.files?.[0], f.line]);
        expect(found).toEqual([['README.md', 1]]);
    });
});
