import { execFileSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { reviewChange } from '../review.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const config = (redundancy: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, gates: { redundancy, unused_exports: { enabled: false }, orphan_files: { enabled: false } } });
const typescriptDir = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));

const DB = `export interface Row { id: string; set_id: string | null; updated_at: string }
export class Query<T> {
    not(_column: string, _operator: string, _value: unknown): Query<T> { return this; }
    gte(_column: string, _value: unknown): Query<T> { return this; }
    returns<R>(): Promise<R> { return Promise.resolve([] as unknown as R); }
}
export function from(_table: string): Query<unknown> { return new Query(); }
`;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    write('package.json', '{"name":"fixture","devDependencies":{"typescript":"*"}}\n');
    write('tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","skipLibCheck":true},"include":["src"]}\n');
    write('.gitignore', 'node_modules\n');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.symlinkSync(typescriptDir, path.join(repo, 'node_modules/typescript'), 'junction'); // the project's own compiler, never downloaded
    write('src/db.ts', DB);
    write('src/main.ts', "export const main = 1;\n");
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'feature');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

const review = (cfg = config()) => reviewChange({ cwd: repo, config: cfg, source: { mode: 'base', base: 'main' }, typed: true });

describe('what a change made redundant', () => {
    it('reports a null filter beside a range on the same column, and the nullable row type the query filters non-null', async () => {
        write('src/scan.ts', `import { from, type Row } from './db';
export async function scan(since: string): Promise<Row[]> {
    return from('t').not('set_id', 'is', null).gte('set_id', since).returns<Row[]>();
}
`);
        git('add', '-A');
        git('commit', '-qm', 'scan');
        const result = await review();
        const found = result.findings.map(f => [f.id, f.files?.[0], f.line]);
        expect(found).toContainEqual(['duplicate-null-filter', 'src/scan.ts', 3]);
        expect(found).toContainEqual(['nullable-filtered-column', 'src/scan.ts', 3]); // anchored on the query the change wrote
        expect(result.findings.find(f => f.id === 'nullable-filtered-column')?.details).toContain('declared nullable at src/db.ts:1');
        expect(result.findings.find(f => f.id === 'duplicate-null-filter')?.details).toContain("`.gte('set_id', …)` at src/scan.ts:3");
    }, 60_000);

    it('reports an optional member every host supplies and a property written but never read; a spread host or a read elsewhere clears them', async () => {
        write('src/types.ts', 'export interface Candidate { userId?: string; title: string; extra: string }\n');
        write('src/a.ts', "import type { Candidate } from './types';\nexport const a: Candidate = { userId: 'u1', title: 'one', extra: 'x' };\n");
        write('src/b.ts', "import type { Candidate } from './types';\nexport const b: Candidate = { userId: 'u2', title: 'two', extra: 'y' };\n");
        write('src/use.ts', "import { a } from './a';\nimport { b } from './b';\nexport const titles = [a.title, b.title];\n");
        git('add', '-A');
        git('commit', '-qm', 'candidates');
        const result = await review();
        const found = result.findings.map(f => [f.id, f.files?.[0]]);
        expect(found).toContainEqual(['optional-always-supplied', 'src/types.ts']);
        expect(found).toContainEqual(['write-only-property', 'src/types.ts']);
        const writeOnly = result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1]);
        expect(writeOnly).toEqual(['Candidate.userId', 'Candidate.extra']); // userId is supplied everywhere and read nowhere: both findings hold
        expect(found.map(([id]) => id)).not.toContain('typed-checks-unavailable');

        // Declared as a wire contract: another service reads it, so nothing on it is write-only.
        const wired = await review(config({ wire_contracts: ['src/types.ts'] }));
        expect(wired.findings.map(f => f.id)).not.toContain('write-only-property');

        // A value that leaves only through serialisation is a hint for the reviewer, not a block.
        write('src/send.ts', "import { a } from './a';\nexport const body = JSON.stringify(a);\n");
        git('add', '-A');
        git('commit', '-qm', 'send');
        const sent = await review();
        expect(sent.findings.map(f => f.id)).not.toContain('write-only-property');
        expect(sent.hints).toEqual([expect.stringContaining('Candidate.userId is set by 2 host(s)'), expect.stringContaining('write-only-property src/types.ts:1: Candidate.extra')]);
        expect(sent.hints[1]).toContain('leaves only through JSON.stringify() at src/send.ts:2');
    }, 60_000);

    it('in a library, an exported type has consumers the program cannot see: its members are hints, a local type still blocks', async () => {
        write('tsconfig.json', '{"compilerOptions":{"strict":true,"declaration":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","skipLibCheck":true},"include":["src"]}\n');
        write('src/types.ts', 'export interface Result { items?: string[]; cached: boolean }\ninterface Local { note: string }\nexport const local: Local = { note: "n" };\n');
        write('src/a.ts', "import type { Result } from './types';\nexport const a: Result = { items: [], cached: true };\n");
        write('src/b.ts', "import type { Result } from './types';\nexport const b: Result = { items: [], cached: false };\n");
        git('add', '-A');
        git('commit', '-qm', 'library');
        const result = await review();
        expect(result.findings.map(f => [f.id, f.details.match(/`([^`]+)`/)![1]])).toEqual([['write-only-property', 'Local.note']]);
        expect(result.hints).toEqual([
            expect.stringMatching(/^optional-always-supplied src\/types\.ts:1: `Result\.items` is optional .* consumers outside this program may read it\)$/),
            expect.stringMatching(/^write-only-property src\/types\.ts:1: `Result\.items` is set by 2 host\(s\)/),
            expect.stringMatching(/^write-only-property src\/types\.ts:1: `Result\.cached` is set by 2 host\(s\)/),
        ]);
    }, 60_000);

    it('hints at a function that scans a collection, called once per item of another', async () => {
        write('src/later.ts', 'export function hasLater(starts: string[], at: string): boolean {\n    return starts.some(s => s > at);\n}\nexport function plan(rows: string[], starts: string[]): boolean[] {\n    return rows.map(r => hasLater(starts, r));\n}\n');
        git('add', '-A');
        git('commit', '-qm', 'later');
        const result = await review();
        expect(result.hints).toEqual([expect.stringMatching(/^nested-scan src\/later\.ts:5: hasLater\(\) scans its `starts` argument and is called inside \.map\(\) over rows/)]);
        expect(result.findings).toEqual([]);
    }, 60_000);

    it('says nothing for a project with no tsconfig, and blocks a TypeScript project whose program cannot be built', async () => {
        write('src/x.ts', 'export const x = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'x');
        fs.unlinkSync(path.join(repo, 'tsconfig.json'));
        expect((await review()).findings).toEqual([]);
        write('tsconfig.json', '{"extends":"./.generated/tsconfig.json"}\n');
        const broken = await review();
        expect(broken.status).toBe('ERROR'); // a check that could not run is a crashed gate, never a pass
        expect(broken.gateErrors).toEqual(['typed-checks-unavailable']);
        expect(broken.typedError).toMatch(/\.generated\/tsconfig\.json.*install the dependencies/s);
    }, 60_000);
});

describe('a nullable row type for a NOT NULL column, from migrations in another repository', () => {
    const SUPABASE = `export class Query<T> {
    select(_columns: string): Query<T> { return this; }
    returns<R>(): Promise<R> { return Promise.resolve([] as unknown as R); }
}
export const db = {
    schema(_name: string) { return db; },
    from(_table: string): Query<unknown> { return new Query(); },
};
`;
    let migrations: string;
    beforeEach(() => {
        migrations = fs.mkdtempSync(path.join(os.tmpdir(), 'other-repo-migrations-'));
        fs.writeFileSync(path.join(migrations, '20240101_sets.sql'), 'create table study_set (id uuid primary key, owner_id uuid not null, title text, archived_at timestamptz not null);');
        write('src/sb.ts', SUPABASE);
        git('add', '-A');
        git('commit', '-qm', 'client');
    });
    afterEach(() => { fs.rmSync(migrations, { recursive: true, force: true }); });

    it('notes the nullable member the change declared, never blocking, and skips nullable columns and aliases', async () => {
        write('src/sets.ts', `import { db } from './sb';
export interface SetRow { id: string; owner_id: string | null; title: string | null; done: string | null }
export async function sets(): Promise<SetRow[]> {
    return db.from('study_set').select('id, owner_id, title, done:archived_at').returns<SetRow[]>();
}
`);
        git('add', '-A');
        git('commit', '-qm', 'sets');
        const result = await review(config({ schema_migrations: [migrations] }));
        expect(result.findings.filter(f => f.id === 'nullable-not-null-column')).toEqual([]);
        const notes = result.advisory.filter(f => f.id === 'nullable-not-null-column');
        expect(notes.map(f => [f.files?.[0], f.line])).toEqual([['src/sets.ts', 2]]);
        expect(notes[0].details).toContain('`owner_id` is declared nullable at src/sets.ts:2 but `study_set.owner_id` is NOT NULL');
    });

    it('anchors on the new query when the row type is older, and reads the schema the query names', async () => {
        fs.writeFileSync(path.join(migrations, '20240202_app.sql'), 'create table app.study_set (id uuid, owner_id uuid);');
        git('checkout', '-q', 'main'); // the row type is older than the branch
        write('src/rows.ts', 'export interface SetRow { id: string; owner_id: string | null }\n');
        git('add', '-A');
        git('commit', '-qm', 'rows');
        git('checkout', '-q', 'feature');
        git('merge', '-q', '--no-edit', 'main');
        write('src/sets.ts', `import { db } from './sb';
import type { SetRow } from './rows';
export async function publicSets(): Promise<SetRow[]> {
    return db
        .from('study_set').select('*').returns<SetRow[]>();
}
export async function appSets(): Promise<SetRow[]> {
    return db.schema('app').from('study_set').select('*').returns<SetRow[]>();
}
`);
        git('add', '-A');
        git('commit', '-qm', 'sets');
        const result = await review(config({ schema_migrations: [migrations] }));
        expect(result.advisory.filter(f => f.id === 'nullable-not-null-column').map(f => [f.files?.[0], f.line])).toEqual([['src/sets.ts', 5]]);
    });
});
