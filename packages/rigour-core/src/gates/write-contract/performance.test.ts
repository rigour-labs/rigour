import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayContracts } from './contracts.js';
import { loadDatabases } from './databases.js';

let repo: string;
beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'write-contract-perf-')); });
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('replaying a large migration history', () => {
    it('stays linear: 600 tables and 1,800 statements it does not read replay in well under a quarter second', () => {
        const sql = Array.from({ length: 600 }, (_, i) => `create table acme_t${i} (id uuid primary key, name text not null);
            create statistics acme_s${i}a on id, name from acme_t${i};
            alter foreign table acme_f${i} add column x int;
            security label on table acme_t${i} is 'x'; import foreign schema remote${i} from server s into public;`);
        const started = performance.now();
        const contracts = replayContracts(sql);
        const elapsed = performance.now() - started;
        // About 20 ms on a laptop; compiling one regex per table and statement took about 400 ms. Generous for a slow
        // runner, still well under the quadratic case (Windows runners are several times slower: see vitest.config.ts).
        expect(elapsed).toBeLessThan(process.platform === 'win32' ? 600 : 250);
        expect(contracts.tables.get('acme_t0')!.unknown).toBe(true);
        expect(contracts.tables.size).toBe(600);
    });

    it('replays a migrations folder once per process while its files are unchanged', async () => {
        const dir = path.join(repo, 'supabase/migrations');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '1_sites.sql'), 'create table acme_sites (id uuid primary key);');
        const [first] = await loadDatabases(repo, [], []);
        const [again] = await loadDatabases(repo, [], []);
        expect(again).toBe(first);
        fs.writeFileSync(path.join(dir, '1_sites.sql'), 'create table acme_sites (id uuid primary key, slug text not null);');
        const [changed] = await loadDatabases(repo, [], []);
        expect(changed).not.toBe(first);
        expect(changed.contracts.tables.get('acme_sites')!.columns.has('slug')).toBe(true);
    });
});
