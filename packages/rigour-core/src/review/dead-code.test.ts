import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { diffFromGit } from './git-diff.js';
import { mustFix } from './quiet.js';
import { orphanFileFailures } from './orphan-files.js';
import { unusedExportFailures } from './unused-exports.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const config = (gates: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, gates });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('src/index.ts', "import { start } from './app';\nstart();\n");
    write('src/app.ts', 'export function start() {}\n');
    write('package.json', '{"scripts":{"seed":"node scripts/seed.mjs"}}\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('unused exports', () => {
    it('reports an added export no other file names, on its own line', () => {
        write('src/app.ts', 'export function start() {}\n\nexport const LIMIT = 5;\nexport function lonely() { return LIMIT; }\n');
        write('src/use.ts', "import { LIMIT } from './app';\nconsole.log(LIMIT);\n");
        const failures = unusedExportFailures(repo, diffFromGit(repo), config());
        expect(failures.map(f => [f.files?.[0], f.line, f.id])).toEqual([['src/app.ts', 4, 'unused-export']]);
        expect(failures[0].details).toContain('`lonely`');
    });

    it('does not count a test as a consumer: an export only its tests import is dead in production', () => {
        write('src/app.ts', 'export function start() {}\n\nexport function onlyTested() { return 1; }\nexport function used() { return 2; }\n');
        write('src/app.test.ts', "import { onlyTested, used } from './app';\nonlyTested();\nused();\n");
        write('tests/helpers.ts', "import { onlyTested } from '../src/app';\nonlyTested();\n");
        write('src/use.ts', "import { used } from './app';\nused();\n");
        const names = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(names).toEqual(['onlyTested']);
    });

    it('reports a re-export nothing imports, without counting the module it comes from as a use', () => {
        write('src/types.ts', 'export type Row = { id: string };\nexport type Used = { n: number };\n');
        write('src/index.ts', "import { start } from './app';\nstart();\nexport type { Row, Used } from './types';\n");
        write('src/consumer.ts', "import type { Used } from './index';\nexport const u: Used = { n: 1 };\nconsole.log(u);\n");
        const names = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => [f.files?.[0], f.details.match(/`([^`]+)`/)![1]]);
        expect(names).toContainEqual(['src/index.ts', 'Row']);
        expect(names).not.toContainEqual(['src/index.ts', 'Used']);
    });

    it('counts an import through a barrel that re-exports the module with export *, a chain of them too', () => {
        write('src/helpers/detect.ts', 'export function viaBarrel() { return 1; }\nexport function viaChain() { return 2; }\nexport function nobody() { return 3; }\n');
        write('src/helpers/index.ts', "export * from './detect.js';\n");
        write('src/all.ts', "export * from './helpers/index.js';\n");
        write('src/gate.ts', "import { viaBarrel } from './helpers/index.js';\nviaBarrel();\n");
        write('src/other.ts', "import { viaChain } from './all';\nviaChain();\n");
        const names = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => [f.files?.[0], f.details.match(/`([^`]+)`/)![1]]);
        expect(names).toEqual([['src/helpers/detect.ts', 'nobody']]);
    });

    it('counts an import through a barrel that re-exports a folder by its name (export * from \'./b\', b/index.ts)', () => {
        write('src/a/b/index.ts', 'export function inFolder() { return 1; }\n');
        write('src/a/index.ts', "export * from './b';\n");
        write('src/use-a.ts', "import { inFolder } from './a';\ninFolder();\n");
        expect(unusedExportFailures(repo, diffFromGit(repo), config())).toEqual([]);
    });

    it('never reports a type-test file as orphaned: tsd runs test-d/ and *.test-d.ts by itself', () => {
        write('test-d/types.ts', "import { start } from '../src/app';\nstart();\n");
        write('src/app.test-d.ts', "import { start } from './app';\nstart();\n");
        const orphans = orphanFileFailures(repo, diffFromGit(repo), config()).map(f => f.files?.[0]);
        expect(orphans).not.toContain('test-d/types.ts');
        expect(orphans).not.toContain('src/app.test-d.ts');
    });

    it('skips what a framework calls by name, and names the team allows', () => {
        write('src/routes/+page.server.ts', 'export const load = () => ({});\nexport const helper = 1;\n');
        write('src/plugin.ts', 'export const register = () => {};\n');
        const names = unusedExportFailures(repo, diffFromGit(repo), config({ unused_exports: { allow: ['register'] } }))
            .map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(names).toEqual(['helper']);
    });

    it('does not count the same word in a file that never imports the module', () => {
        write('src/payload.ts', 'export function eventId(kind: string) { return kind; }\nexport const used = eventId("x");\n');
        write('src/main2.ts', "import { used } from './payload';\nconsole.log(used);\n");
        write('src/routes/[eventId]/handler.ts', "const eventId = 'route-param';\nconsole.log(eventId);\n");
        write('src/schedule.ts', 'const eventId = 7;\nconsole.log(eventId);\n');
        const names = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(names).toContain('eventId');
        expect(names).not.toContain('used');
    });

    it('reports a type imported then exported again that nothing imports from here', () => {
        write('src/entry.ts', "export type Entry = 'a' | 'b';\n");
        write('src/resume.ts', "import type { Entry } from './entry';\nexport type { Entry };\nexport const pick = (e: Entry) => e;\n");
        write('src/main.ts', "import { pick } from './resume';\nconsole.log(pick('a'));\n");
        const found = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => [f.files?.[0], f.details.match(/`([^`]+)`/)![1]]);
        expect(found).toContainEqual(['src/resume.ts', 'Entry']);
        expect(found).not.toContainEqual(['src/entry.ts', 'Entry']);
    });

    it("never counts Rigour's own report as a use", () => {
        write('src/app.ts', 'export function start() {}\nexport const orphanName = 1;\n');
        write('rigour-report.json', '{"failures":[{"details":"orphanName"}]}\n');
        expect(unusedExportFailures(repo, diffFromGit(repo), config())).toHaveLength(1);
    });

    it('reports dead code as a note unless the team blocks on it', () => {
        write('src/app.ts', 'export function start() {}\nexport function lonely() { return 1; }\n');
        write('src/new-tool.ts', 'export const tool = 1;\n');
        const found = (gates: Record<string, unknown> = {}) => [
            ...unusedExportFailures(repo, diffFromGit(repo), config(gates)),
            ...orphanFileFailures(repo, diffFromGit(repo), config(gates)),
        ];
        expect(found().map(f => [f.id, mustFix(f)])).toEqual(expect.arrayContaining([['unused-export', false], ['orphan-file', false]]));
        const strict = found({ unused_exports: { block: true }, orphan_files: { block: true } });
        expect(strict.length).toBeGreaterThan(0);
        expect(strict.every(mustFix)).toBe(true);
    });

    it('is off when disabled', () => {
        write('src/app.ts', 'export function start() {}\nexport const x = 1;\n');
        expect(unusedExportFailures(repo, diffFromGit(repo), config({ unused_exports: { enabled: false } }))).toEqual([]);
    });
});

describe('package layout', () => {
    it("never reports a package entry point's exports, which are its public API", () => {
        write('packages/lib/package.json', '{"name":"lib","main":"dist/index.js","types":"dist/index.d.ts"}\n');
        write('packages/lib/src/index.ts', "export { helper, type Shape } from './helper';\n");
        write('packages/lib/src/helper.ts', 'export type Shape = { a: 1 };\nexport const helper = 1;\n');
        write('packages/lib/src/tools/index.ts', "export { toolA } from './a';\n");
        write('packages/lib/src/tools/a.ts', 'export const toolA = 1;\n');
        write('packages/lib/src/index.ts', "export { helper, type Shape } from './helper';\nexport * from './tools/index.js';\n");
        const reported = unusedExportFailures(repo, diffFromGit(repo), config()).map(f => f.files?.[0]);
        expect(reported).not.toContain('packages/lib/src/index.ts');
        expect(reported).not.toContain('packages/lib/src/tools/index.ts'); // re-exported whole by the entry
    });

    it('keeps an exported type in a signature when the project emits declarations, and only then', () => {
        write('src/run.ts', 'export interface RunResult { ok: boolean }\nexport function run(): RunResult { return { ok: true }; }\n');
        write('src/main.ts', "import { run } from './run';\nrun();\n");
        const names = () => unusedExportFailures(repo, diffFromGit(repo), config()).map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(names()).toContain('RunResult'); // an application: drop the export
        write('tsconfig.base.json', '{ "compilerOptions": { "declaration": true } }\n');
        write('tsconfig.json', '{ "extends": "./tsconfig.base.json" }\n');
        expect(names()).not.toContain('RunResult'); // a library: TypeScript needs it exported
    });

    it("counts a package.json bin or main path as running its source file", () => {
        write('packages/tool/package.json', '{"name":"tool","bin":{"tool":"dist/bin.js"}}\n');
        write('packages/tool/src/bin.ts', 'console.log("hi");\n');
        expect(orphanFileFailures(repo, diffFromGit(repo), config())).toEqual([]);
    });
});

describe('orphaned files', () => {
    it('reports new files nothing outside the new files reaches, including a pair that only import each other', () => {
        write('src/wired.ts', 'export const w = 1;\n');
        write('src/index.ts', "import { start } from './app';\nimport { w } from './wired';\nstart(w);\n");
        write('src/lonely.ts', 'export const l = 1;\n');
        write('src/pair/a.ts', "import { b } from './b';\nexport const a = b;\n");
        write('src/pair/b.ts', "import { a } from './a';\nexport const b = a;\n");
        write('scripts/seed.mjs', 'console.log(1);\n');
        write('src/tested.ts', 'export const t = 1;\n');
        write('src/tested.test.ts', "import { t } from './tested';\n"); // a test runs it: reached
        const files = orphanFileFailures(repo, diffFromGit(repo), config()).map(f => f.files?.[0]).sort();
        expect(files).toEqual(['src/lonely.ts', 'src/pair/a.ts', 'src/pair/b.ts']);
    });

    it('lets a file through when a docs page is its only mention, and honours allow globs', () => {
        write('src/tool.ts', 'export const t = 1;\n');
        write('docs/tool.md', 'Run `src/tool.ts` by hand.\n');
        expect(orphanFileFailures(repo, diffFromGit(repo), config()).map(f => f.files?.[0])).toEqual(['src/tool.ts']);
        expect(orphanFileFailures(repo, diffFromGit(repo), config({ orphan_files: { allow: ['src/tool.ts'] } }))).toEqual([]);
    });
});
