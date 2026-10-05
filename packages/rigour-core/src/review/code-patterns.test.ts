import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { parseDiff } from '../utils/diff.js';
import { diffFromGit } from './git-diff.js';
import { duplicateFunctionFailures } from './duplicate-functions.js';
import { optionalParamFailures } from './optional-params.js';
import { queryPatternFailures } from './query-patterns.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const config = ConfigSchema.parse({ version: 1 });
const changed = () => parseDiff(diffFromGit(repo));

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'code-patterns-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('README.md', 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('query patterns', () => {
    it('reports offset paging in a loop and in a pager callback, not a single page a request asks for', () => {
        write('src/sweep.ts', [
            'export async function sweep(db: any) {',
            '  for (let from = 0; ; from += 500) {',
            "    const { data } = await db.from('rows').select('id').order('id').range(from, from + 499);",
            '    if (!data?.length) return;',
            '  }',
            '}',
            "export const all = (db: any) => readAllPages((from: number, to: number) => db.from('rows').select('id').order('id').range(from, to));",
            "export function page(db: any, from: number, to: number) { return db.from('rows').select('id').range(from, to); }",
            'declare function readAllPages(f: (from: number, to: number) => unknown): unknown;',
        ].join('\n'));
        expect(queryPatternFailures(repo, changed(), config).map(f => [f.id, f.line])).toEqual([['offset-paging', 3], ['offset-paging', 7]]);
    });

    it('reports a window read only from its start, not a bounded window or everything since an event', () => {
        write('src/window.ts', [
            "export const open = (db: any, window: { from: string; to: string }) => db.from('events').select('id').gte('created_at', window.from);",
            "export const closed = (db: any, window: { from: string; to: string }) => db.from('events').select('id').gte('created_at', window.from).lte('created_at', window.to);",
            "export const since = (db: any, since: string) => db.from('events').select('id').gt('started_at', since);",
        ].join('\n'));
        expect(queryPatternFailures(repo, changed(), config).map(f => [f.id, f.line])).toEqual([['unbounded-window', 1]]);
    });
});

describe('optional for tests', () => {
    it('reports an optional parameter or option that every production call passes and only a test omits', () => {
        write('src/build.ts', 'export function build(items: string[], opts: { resumes?: string[] }, limit?: number) { return [items, opts, limit]; }\n');
        write('src/run.ts', "import { build } from './build';\nbuild(['a'], { resumes: [] }, 5);\n");
        write('src/build.test.ts', "import { build } from './build';\nbuild(['a'], {});\n");
        const found = optionalParamFailures(repo, changed(), config).map(f => f.details.match(/`([^`]+)`/)![1]).sort();
        expect(found).toEqual(['limit', 'resumes']);
    });

    it('stays quiet when production itself omits it, or when tests pass it too', () => {
        write('src/build.ts', 'export function build(items: string[], limit?: number) { return [items, limit]; }\n');
        write('src/run.ts', "import { build } from './build';\nbuild(['a']);\nbuild(['b'], 2);\n");
        write('src/build.test.ts', "import { build } from './build';\nbuild(['a']);\n");
        expect(optionalParamFailures(repo, changed(), config)).toEqual([]);
    });
});

describe('duplicate functions', () => {
    const body = (name: string) => `export function ${name}(x: number) {\n  const a = x + 1;\n  const b = a * 2;\n  if (b > 10) return b;\n  console.log(a, b);\n  return a;\n}\n`;

    it('reports a changed function whose body copies another, in TypeScript and Svelte alike', () => {
        write('src/a.ts', body('first'));
        write('src/b.svelte', `<script lang="ts">\n${body('second').replace('export ', '')}</script>\n<p>hi</p>\n`);
        const found = duplicateFunctionFailures(repo, changed(), config);
        expect(found.map(f => [f.files?.[0], f.line])).toEqual([['src/b.svelte', 2]]);
        expect(found[0].details).toContain('`first` in `src/a.ts:1`');
    });

    it('ignores small look-alike functions', () => {
        write('src/a.ts', 'export const one = (x: number) => { return x + 1; };\n');
        write('src/b.ts', 'export const two = (x: number) => { return x + 1; };\n');
        expect(duplicateFunctionFailures(repo, changed(), config)).toEqual([]);
    });
});
