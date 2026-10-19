import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WriteContractGate } from './index.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const run = () => new WriteContractGate().run({ cwd: repo, patterns: ['src/**/*.ts'] });
const upsert = (row: string, onConflict: string) => `import { createClient } from '@supabase/supabase-js';
export const sync = () => createClient('https://example.supabase.co', 'anon').from('acme_sites').upsert(${row}, { onConflict: '${onConflict}' });
`;
const table = (keys: string) => `create table acme_sites (id uuid primary key default gen_random_uuid(), org_id uuid not null, slug text not null${keys});`;

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'write-contract-keys-')); });
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('ON CONFLICT targets and the keys that cover them', () => {
    it.each([
        ['unique(org_id, slug) with no space', ', unique(org_id, slug)'],
        ['a named UNIQUE(a,b) with no space', ', CONSTRAINT acme_sites_org_slug UNIQUE(org_id,slug)'],
        ['a composite primary key(a,b) with no space', ''],
    ])('finds %s', async (_label, keys) => {
        write('supabase/migrations/1_sites.sql', keys ? table(keys) : 'create table acme_sites (org_id uuid not null, slug text not null, primary key(org_id,slug));');
        write('src/sync.ts', upsert("{ org_id: 'o', slug: 's' }", 'org_id,slug'));
        expect(await run()).toEqual([]);
    });

    it('keeps quoted mixed-case key columns as written, inline and at table level', async () => {
        write('supabase/migrations/1_sites.sql', `create table acme_sites (id uuid primary key, "OrgId" uuid not null, "Slug" text not null unique, unique ("OrgId", "Slug"));`);
        write('src/sync.ts', `${upsert("{ id: 'i', OrgId: 'o', Slug: 's' }", 'Slug')}export const both = () => createClient('u', 'k').from('acme_sites').upsert({ id: 'i', OrgId: 'o', Slug: 's' }, { onConflict: 'OrgId,Slug' });\nimport { createClient } from '@supabase/supabase-js';\n`);
        expect(await run()).toEqual([]);
    });

    it('reports a target only a partial unique index covers, and accepts it in SQL that writes the predicate', async () => {
        write('supabase/migrations/1_sites.sql', `${table('')}\ncreate unique index acme_sites_live_slug on acme_sites (org_id, slug) where slug <> 'draft';`);
        write('src/sync.ts', upsert("{ org_id: 'o', slug: 's' }", 'org_id,slug'));
        const failures = await run();
        expect(failures.map(f => f.details)).toEqual([expect.stringContaining('only a partial unique index (one with a WHERE) covers those columns')]);
        write('src/sync.ts', `export const q = "insert into acme_sites (org_id, slug) values ($1, $2) on conflict (org_id, slug) where slug <> 'draft' do nothing";\n`);
        expect(await run()).toEqual([]);
    });

    it('reports a target only a deferrable unique constraint covers', async () => {
        write('supabase/migrations/1_sites.sql', table(', constraint acme_sites_org_slug unique (org_id, slug) deferrable initially deferred'));
        write('src/sync.ts', upsert("{ org_id: 'o', slug: 's' }", 'org_id,slug'));
        expect((await run()).map(f => f.details)).toEqual([expect.stringContaining('only a deferrable unique constraint covers those columns')]);
        write('supabase/migrations/2_sites.sql', 'alter table acme_sites alter constraint acme_sites_org_slug not deferrable;');
        expect(await run()).toEqual([]);
    });

    it('stays silent on a docs-like string that names a known table with a valid shape', async () => {
        write('supabase/migrations/1_sites.sql', table(''));
        write('src/help.ts', `export const HELP = "insert into acme_sites (org_id, slug) values ('acme', 'north')";\n`);
        expect(await run()).toEqual([]);
    });
});
