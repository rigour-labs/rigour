import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { diffFromGit } from './git-diff.js';
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

    it('skips what a framework calls by name, and names the team allows', () => {
        write('src/routes/+page.server.ts', 'export const load = () => ({});\nexport const helper = 1;\n');
        write('src/plugin.ts', 'export const register = () => {};\n');
        const names = unusedExportFailures(repo, diffFromGit(repo), config({ unused_exports: { allow: ['register'] } }))
            .map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(names).toEqual(['helper']);
    });

    it("never counts Rigour's own report as a use", () => {
        write('src/app.ts', 'export function start() {}\nexport const orphanName = 1;\n');
        write('rigour-report.json', '{"failures":[{"details":"orphanName"}]}\n');
        expect(unusedExportFailures(repo, diffFromGit(repo), config())).toHaveLength(1);
    });

    it('is off when disabled', () => {
        write('src/app.ts', 'export function start() {}\nexport const x = 1;\n');
        expect(unusedExportFailures(repo, diffFromGit(repo), config({ unused_exports: { enabled: false } }))).toEqual([]);
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
