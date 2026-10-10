import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { parseDiff } from '../utils/diff.js';
import { diffFromGit } from './git-diff.js';
import { duplicateFunctionFailures } from './duplicate-functions.js';
import { loopCopyFailures } from './loop-copies.js';
import { partialFixFailures } from './partial-fixes.js';
import { partialWiringFailures } from './partial-wiring.js';
import { optionalParamFailures } from './optional-params.js';
import { queryPatternFailures } from './query-patterns.js';
import { reviewChange } from './review.js';

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

describe('checks learned from review history', () => {
    it('show their findings as notes by default, and block only when the team opts in', async () => {
        write('src/sweep.ts', [
            'export async function sweep(db: any) {',
            '  for (let from = 0; ; from += 500) {',
            "    const { data } = await db.from('rows').select('id').order('id').range(from, from + 499);",
            '    if (!data?.length) return;',
            '  }',
            '}',
        ].join('\n'));
        const quiet = { unused_exports: { enabled: false }, orphan_files: { enabled: false } };
        const byDefault = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1, gates: quiet }) });
        expect(byDefault.findings.map(f => f.id)).not.toContain('offset-paging');
        expect(byDefault.advisory.find(f => f.id === 'offset-paging')).toMatchObject({ certainty: 'likely' });
        const opted = await reviewChange({ cwd: repo, config: ConfigSchema.parse({ version: 1, gates: { ...quiet, query_patterns: { block: true } } }) });
        expect(opted.findings.find(f => f.id === 'offset-paging')).toMatchObject({ certainty: 'proven' });
        expect(opted.status).toBe('FAIL');
    }, 30_000);
});

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

describe('quadratic copies', () => {
    it('reports an accumulator spread into a new copy on every step, not a push', () => {
        write('src/group.ts', [
            'export function group(items: { day: string }[]) {',
            '  const groups = new Map<string, { day: string }[]>();',
            '  for (const item of items) groups.set(item.day, [...(groups.get(item.day) ?? []), item]);',
            '  const ids = items.reduce((acc: string[], item) => [...acc, item.day], []);',
            '  const fast = new Map<string, string[]>();',
            '  for (const item of items) (fast.get(item.day) ?? fast.set(item.day, []).get(item.day)!).push(item.day);',
            '  return { groups, ids, fast };',
            '}',
        ].join('\n'));
        expect(loopCopyFailures(repo, changed(), config).map(f => f.line)).toEqual([3, 4]);
    });
});

describe('partial fixes', () => {
    it('names the places that still test the narrower condition a new predicate widened', () => {
        write('src/routes/session/page.server.ts', 'export function load(snapshot: any) {\n  if (snapshot.answeredCount > 0) return 1;\n  return 0;\n}\n');
        write('src/routes/session/page.svelte', '<script lang="ts">\n  const show = data.snapshot.answeredCount > 0;\n</script>\n');
        git('add', '-A');
        git('commit', '-qm', 'before');
        write('src/routes/session/page.server.ts', 'export function load(snapshot: any) {\n  if (snapshot.answeredCount > 0) return 1;\n  return 0;\n}\nexport const resume = (snapshot: any) => {\n  const hasSaved = snapshot.answers.length > 0 || snapshot.answeredCount > 0;\n  return hasSaved;\n};\n');
        const found = partialFixFailures(repo, changed(), config);
        expect(found.map(f => [f.id, f.line])).toEqual([['partial-fix', 6]]);
        expect(found[0].details).toContain('page.server.ts:2');
        expect(found[0].details).toContain('page.svelte:2');
    });
});

describe('partial wiring', () => {
    const mount = (extra: string) => `<script lang="ts">\n  import Player from '$lib/Player.svelte';\n</script>\n<Player\n  mode="quiz"\n  {questions}${extra}\n/>\n`;

    it('reports a callback added to most same-kind mounts of a local component but not one', () => {
        write('src/lib/Player.svelte', '<script lang="ts">let { onResume } = $props();</script>\n');
        for (const route of ['a', 'b', 'c']) write(`src/routes/${route}/+page.svelte`, mount(''));
        write('src/routes/d/+page.svelte', mount('').replace('mode="quiz"', 'mode="exam"'));
        git('add', '-A');
        git('commit', '-qm', 'mounts');
        write('src/routes/a/+page.svelte', mount('\n  {onResume}'));
        write('src/routes/b/+page.svelte', mount('\n  {onResume}'));
        const found = partialWiringFailures(repo, changed(), config);
        expect(found).toHaveLength(1);
        expect(found[0].details).toContain('src/routes/c/+page.svelte');
        expect(found[0].details).not.toContain('routes/d'); // another kind of mount
    });

    it('ignores styling props and components from packages', () => {
        const icon = (extra: string) => `<script lang="ts">\n  import { Star } from 'lucide-svelte';\n</script>\n<Star class="h-4"${extra} />\n`;
        for (const route of ['a', 'b', 'c']) write(`src/routes/${route}/+page.svelte`, icon(''));
        git('add', '-A');
        git('commit', '-qm', 'icons');
        write('src/routes/a/+page.svelte', icon(' onHover={go}'));
        write('src/routes/b/+page.svelte', icon(' onHover={go}'));
        expect(partialWiringFailures(repo, changed(), config)).toEqual([]);
    });
});
