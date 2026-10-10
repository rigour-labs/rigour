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

    it('follows a value into a property declared as a same-shape inline type: when that type is serialised, every field of the value\'s type is a hint', async () => {
        write('src/types.ts', 'export interface A { x: string; y: string }\n');
        write('src/rows.ts', 'export interface R { id: string; p?: { x: string; y: string } }\nexport interface Body { results: R[] }\n');
        write('src/g.ts', `import type { A } from './types';
function make(id: string): A { return { x: id, y: id }; }
export function g(ids: string[]): Map<string, A> { return new Map(ids.map(id => [id, make(id)])); }
`);
        write('src/h.ts', `import { g } from './g';
import type { R } from './rows';
export function h(rows: R[]): R[] {
    const found = g(rows.map(r => r.id));
    return rows.map(r => { const a = found.get(r.id); return a ? { ...r, p: a } : r; });
}
`);
        write('src/send.ts', `import { h } from './h';
import type { Body, R } from './rows';
function k(body: Body): string { return JSON.stringify(body); }
export function handler(rows: R[]): string { const body: Body = { results: h(rows) }; return k(body); }
`);
        git('add', '-A');
        git('commit', '-qm', 'serialised through a same-shape inline type');
        const result = await review();
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual([]);
        const hints = result.hints.filter(h => h.startsWith('write-only-property src/types.ts'));
        expect(hints).toEqual([expect.stringContaining('A.x is set by 1 host(s)'), expect.stringContaining('A.y is set by 1 host(s)')]);
        expect(hints[0]).toContain('JSON.stringify() at src/send.ts:3');
        expect(hints[0]).toContain('carried as R');
    }, 60_000);

    it('counts a read through the same-shape type a value was carried as, as a read of the value\'s field', async () => {
        write('src/types.ts', 'export interface A { x: string; y: string }\n');
        write('src/rows.ts', 'export interface R { id: string; p?: { x: string; y: string } }\n');
        write('src/h.ts', `import type { A } from './types';
import type { R } from './rows';
function make(id: string): A { return { x: id, y: id }; }
export function h(rows: R[]): R[] { return rows.map(r => ({ ...r, p: make(r.id) })); }
export const marked = (rows: R[]) => h(rows).filter(r => r.p?.x).length;
`);
        git('add', '-A');
        git('commit', '-qm', 'read through the carrying type');
        const result = await review();
        // x is read as R.p.x; its sibling y is read nowhere and still blocks.
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual(['A.y']);
    }, 60_000);

    it('follows a Map round trip, an async return and an inline Response.json to the serialiser: every field of the carried type is a hint', async () => {
        // The field shape: A is written into a Map, read back as A | undefined, spread into R (whose p is a same-shape
        // inline type, declared in another module), returned from an async function, and serialised inline.
        write('tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022","lib":["es2022","dom"],"moduleResolution":"bundler","skipLibCheck":true},"include":["src"]}\n');
        write('src/contracts.ts', 'export interface R { id: string; label: string; p?: { x: string; y: number } }\n');
        write('src/lookup.ts', `import type { R } from './contracts';
export interface A { x: string; y: number }
function f(e: number): string { return String(e); }
function g(ids: string[]): Map<string, A> {
    const m = new Map<string, A>();
    ids.forEach((id, e) => { m.set(id, { x: f(e), y: e }); });
    return m;
}
export async function h(rows: R[], onErr = (_e: unknown) => {}): Promise<R[]> {
    let m = new Map<string, A>();
    try { m = g(rows.map(r => r.id)); } catch (e) { onErr(e); }
    return rows.map(r => { const id = r.id; const a = id ? m.get(id) : undefined; return a ? { ...r, p: a } : r; });
}
`);
        write('src/handlers.ts', `import { h } from './lookup';
import type { R } from './contracts';
const init = { status: 200 };
export async function list(rows: R[]): Promise<Response> {
    const results = await h(rows);
    return Response.json({ ok: true, count: results.length, results }, init);
}
export async function one(row: R): Promise<Response> {
    const [result] = await h([row]);
    return Response.json({ ok: true, label: row.label, result }, init);
}
`);
        git('add', '-A');
        git('commit', '-qm', 'the field shape');
        const result = await review();
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual([]);
        const hints = result.hints.filter(h => h.startsWith('write-only-property src/lookup.ts'));
        expect(hints).toEqual([expect.stringContaining('A.x is set by 1 host(s)'), expect.stringContaining('A.y is set by 1 host(s)')]);
        // A is stored in a Map before anything serialises it: the first exit found, and enough to make it a hint.
        expect(hints[0]).toContain('may leave through Map.set() at src/lookup.ts:6, a container');
    }, 60_000);

    it('makes the fields of a value stored in a container hints that name it, though nothing serialises it, and still blocks the type never stored', async () => {
        write('tsconfig.json', '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022","lib":["es2022","dom"],"moduleResolution":"bundler","skipLibCheck":true},"include":["src"]}\n');
        write('src/contracts.ts', 'export interface R { id: string; label: string; p?: { x: string; y: number } }\n');
        write('src/lookup.ts', `import type { R } from './contracts';
export interface A { x: string; y: number }
function g(ids: string[]): Map<string, A> {
    const m = new Map<string, A>();
    ids.forEach((id, e) => { m.set(id, { x: String(e), y: e }); });
    return m;
}
export async function h(rows: R[]): Promise<R[]> {
    const m = g(rows.map(r => r.id));
    return rows.map(r => { const a = m.get(r.id); return a ? { ...r, p: a } : r; });
}
`);
        write('src/handlers.ts', `import { h } from './lookup';
import type { R } from './contracts';
export async function count(rows: R[]): Promise<number> { return (await h(rows)).filter(r => r.label).length; }
`);
        git('add', '-A');
        git('commit', '-qm', 'the field shape, never serialised');
        const result = await review();
        // A goes into a Map: whatever reads the Map may send it on, so its fields are hints naming the Map.
        expect(result.hints.filter(h => h.startsWith('write-only-property src/lookup.ts'))).toEqual([
            expect.stringContaining('A.x is set by 1 host(s) and read by no code; the value may leave through Map.set() at src/lookup.ts:5, a container'),
            expect.stringContaining('A.y is set by 1 host(s)'),
        ]);
        // R is never stored, returned to an uncalled entry or sent: R.p still blocks.
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual(['R.p']);
    }, 60_000);

    it('treats an array push, an index assignment, a Set and the return of an export nothing calls as places a value may leave', async () => {
        write('src/kinds.ts', `export interface Pushed { id: string; note: string }
export interface Indexed { id: string; note: string }
export interface Added { id: string; note: string }
export interface Returned { id: string; note: string }
export interface Kept { id: string; note: string }
const log: Pushed[] = [];
const byId: Record<string, Indexed> = {};
const seen = new Set<Added>();
export function record(id: string): void {
    log.push({ id, note: 'a' });
    byId[id] = { id, note: 'b' };
    seen.add({ id, note: 'c' });
}
export function entry(id: string): Returned { return { id, note: 'd' }; }
function keep(id: string): Kept { return { id, note: 'e' }; }
export const kept = (id: string) => keep(id).id;
`);
        git('add', '-A');
        git('commit', '-qm', 'containers and an uncalled entry');
        const result = await review();
        const hinted = result.hints.map(h => h.match(/^write-only-property [^:]+:\d+: (\w+)\.note is set/)?.[1]).filter(Boolean);
        expect(hinted.sort()).toEqual(['Added', 'Indexed', 'Pushed', 'Returned']);
        // Kept is only returned to code in this program that reads its id: never stored, never sent. Its note still blocks.
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual(['Kept.note']);
    }, 60_000);

    it('still blocks a field of a value carried as another type when that type never leaves the program', async () => {
        write('src/types.ts', 'export interface A { x: string; y: string }\n');
        write('src/rows.ts', 'export interface R { id: string; p?: { x: string; y: string } }\n');
        write('src/h.ts', `import type { A } from './types';
import type { R } from './rows';
function make(id: string): A { return { x: id, y: id }; }
export function h(rows: R[]): R[] { return rows.map(r => ({ ...r, p: make(r.id) })); }
export const count = (rows: R[]) => h(rows).length;
`);
        git('add', '-A');
        git('commit', '-qm', 'carried, never serialised');
        const result = await review();
        expect(result.findings.filter(f => f.id === 'write-only-property').map(f => f.details.match(/`([^`]+)`/)![1])).toEqual(['A.x', 'A.y']);
    }, 60_000);

    it('keeps a member optional, as a hint, when values of the type are read back from JSON written before it existed', async () => {
        write('src/store.ts', `import fs from 'fs';
interface Entry { file: string; stamp?: string }
export function record(file: string): Entry { return { file, stamp: 'v2' }; }
export function again(file: string): Entry { return { file, stamp: 'v2' }; }
export function load(): Record<string, Entry> {
    return JSON.parse(fs.readFileSync('open.json', 'utf8'));
}
export const stamps = Object.values(load()).map(e => e.stamp ?? 'v1').concat(record('a').file, again('b').file);
`);
        git('add', '-A');
        git('commit', '-qm', 'store');
        const result = await review();
        expect(result.findings.map(f => f.id)).not.toContain('optional-always-supplied');
        expect(result.hints).toContainEqual(expect.stringMatching(/^optional-always-supplied src\/store\.ts:2: `Entry\.stamp` is optional but every host supplies it .* read back from JSON at src\/store\.ts:6/));

        // The same through an assertion and an annotated variable; without any JSON read, the finding still blocks.
        write('src/store.ts', `import fs from 'fs';
interface Entry { file: string; stamp?: string }
export function record(file: string): Entry { return { file, stamp: 'v2' }; }
export function again(file: string): Entry { return { file, stamp: 'v2' }; }
export const all = (fs.readFileSync('a.jsonl', 'utf8').split('\\n').map(line => JSON.parse(line) as Entry)).map(e => e.stamp ?? 'v1').concat(record('a').file, again('b').file);
`);
        git('add', '-A');
        git('commit', '-qm', 'as');
        expect((await review()).findings.map(f => f.id)).not.toContain('optional-always-supplied');
        write('src/store.ts', `interface Entry { file: string; stamp?: string }
export function record(file: string): Entry { return { file, stamp: 'v2' }; }
export function again(file: string): Entry { return { file, stamp: 'v2' }; }
export const all = [record('a'), again('b')].map(e => e.stamp ?? 'v1' + e.file);
`);
        git('add', '-A');
        git('commit', '-qm', 'no json');
        expect((await review()).findings.map(f => f.id)).toContain('optional-always-supplied');
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

describe('a null guard on a column the query makes non-null', () => {
    const SESSION = `import { from } from './db';
export interface Session { id: string; ended_at: string | null; label: string | null }
export async function endedSessions(): Promise<Session[]> {
    return from('sessions').not('ended_at', 'is', null).returns<Session[]>();
}
`;
    const CONSUMER = `import { endedSessions } from './sessions';
export async function summary(): Promise<string[]> {
    const rows = await endedSessions();
    return rows.map(row => {
        if (row.ended_at == null) return 'open';
        const ended = row.ended_at ?? 'never';
        if (!row.label) return ended;
        return row.label;
    });
}
`;
    const guards = async () => (await review()).advisory.filter(f => f.id === 'dead-null-guard').map(f => [f.files?.[0], f.line]);

    it('names each guard the filter made dead, and leaves a guard on a column no query filters alone', async () => {
        write('src/sessions.ts', SESSION);
        write('src/summary.ts', CONSUMER);
        git('add', '-A');
        git('commit', '-qm', 'sessions');
        expect(await guards()).toEqual([['src/summary.ts', 5], ['src/summary.ts', 6]]);
    });

    it("names a truthiness test on a filtered string column with the empty-string case, and leaves a number's alone", async () => {
        write('src/sessions.ts', `import { from } from './db';
export interface Visit { id: string; page: string | null; seconds: number | null }
export async function visits(): Promise<Visit[]> {
    return from('visits').not('page', 'is', null).not('seconds', 'is', null).returns<Visit[]>();
}
export async function pages(): Promise<string[]> {
    return (await visits()).filter(v => !!v.page && !v.seconds).map(v => v.page ?? '');
}
`);
        git('add', '-A');
        git('commit', '-qm', 'visits');
        const result = (await review()).advisory.filter(f => f.id === 'dead-null-guard');
        expect(result.map(f => f.line)).toEqual([7, 7]); // \`!v.page\` and \`v.page ?? ''\`, not \`!v.seconds\`
        expect(result.some(f => /empty string/.test(f.details ?? ''))).toBe(true);
    });

    it('follows a query typed through a generic pager and an intersection, and ignores the pager\'s own type parameter', async () => {
        write('src/pager.ts', `import { from, type Query } from './db';
export async function readAll<Row>(page: () => Query<unknown>): Promise<Row[]> {
    await page();
    return from('audit').returns<Row[]>(); // the helper's own query, typed by its parameter: not a row type
}
`);
        write('src/sessions.ts', `import { from } from './db';
import { readAll } from './pager';
export interface Session { id: string; ended_at: string | null }
export async function endedSessions(): Promise<Session[]> {
    return readAll<Session & Record<string, unknown>>(() => from('sessions').not('ended_at', 'is', null));
}
export async function summary(): Promise<string[]> {
    return (await endedSessions()).map(row => row.ended_at ?? 'never');
}
`);
        git('add', '-A');
        git('commit', '-qm', 'pager');
        expect(await guards()).toEqual([['src/sessions.ts', 8]]);
    });

    it('says nothing when another query returns the same rows unfiltered', async () => {
        write('src/sessions.ts', `${SESSION}export async function allSessions(): Promise<Session[]> {
    return from('sessions').returns<Session[]>();
}
`);
        write('src/summary.ts', CONSUMER);
        git('add', '-A');
        git('commit', '-qm', 'sessions');
        expect(await guards()).toEqual([]);
    });

    it('says nothing when code builds such a row with the column null', async () => {
        write('src/sessions.ts', `${SESSION}export const draft: Session = { id: 'new', ended_at: null, label: null };
`);
        write('src/summary.ts', CONSUMER);
        git('add', '-A');
        git('commit', '-qm', 'sessions');
        expect(await guards()).toEqual([]);
    });
});

describe('an input production never varies', () => {
    const found = async (id: string) => (await review()).advisory.filter(f => f.id === id).map(f => [f.files?.[0], f.line]);
    const commit = () => { git('add', '-A'); git('commit', '-qm', 'change'); };

    it('names a member every production object sets to the same value while code branches on it; tests do not count', async () => {
        write('src/jobs.ts', `export interface Job { id: string; retries: number }
export function next(job: Job): string { return job.retries > 0 ? 'retry' : 'run'; }
export const nightly: Job = { id: 'nightly', retries: 0 };
export const hourly: Job = { id: 'hourly', retries: 0 };
`);
        write('src/jobs.test.ts', `import { next } from './jobs';
export const flaky = next({ id: 'flaky', retries: 3 });
`);
        commit();
        expect(await found('constant-member')).toEqual([['src/jobs.ts', 1]]);
    });

    it('says nothing when production sets the member differently', async () => {
        write('src/jobs.ts', `export interface Job { id: string; retries: number }
export function next(job: Job): string { return job.retries > 0 ? 'retry' : 'run'; }
export const nightly: Job = { id: 'nightly', retries: 0 };
export const hourly: Job = { id: 'hourly', retries: 2 };
`);
        commit();
        expect(await found('constant-member')).toEqual([]);
    });

    it('names a parameter every production call passes the same literal while the body branches on it', async () => {
        write('src/format.ts', `export function label(text: string, upper: boolean): string { return upper ? text.toUpperCase() : text; }
export const a = label('one', false);
export const b = label('two', false);
export function wrap(text: string, client: { send(t: string): string }): string { return client.send(text); }
`);
        write('src/send.ts', `import { wrap } from './format';
const client = { send: (t: string) => t };
export const x = wrap('a', client);
export const y = wrap('b', client); // the same variable name is not the same literal
`);
        write('src/format.test.ts', `import { label } from './format';
export const loud = label('three', true);
`);
        commit();
        expect(await found('constant-argument')).toEqual([['src/format.ts', 1]]);
    });

    it('says nothing when production calls vary, or the function is passed around as a value', async () => {
        write('src/format.ts', `export function label(text: string, upper: boolean): string { return upper ? text.toUpperCase() : text; }
export const a = label('one', false);
export const b = label('two', true);
export function shout(text: string, loud: boolean): string { return loud ? text + '!' : text; }
export const c = shout('x', false);
export const d = shout('y', false);
export const handlers = [shout];
`);
        commit();
        expect(await found('constant-argument')).toEqual([]);
    });
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
