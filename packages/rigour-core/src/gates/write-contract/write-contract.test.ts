import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WriteContractGate } from './index.js';
import { GateRunner } from '../runner.js';
import { ConfigSchema } from '../../types/index.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const run = (config: { block?: boolean; enabled?: boolean } = {}) => new WriteContractGate(config).run({ cwd: repo, patterns: ['src/**/*.ts'] });
const migrate = (sql: string, name = '20260101000000_init.sql') => write(`supabase/migrations/${name}`, sql);

const ACCOUNTS = `create type public.plan_tier as enum ('free', 'team');
create table public.acme_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  slug text not null,
  plan plan_tier not null default 'free',
  status text not null default 'active' check (status in ('active', 'paused')),
  synced_at timestamptz not null default now(),
  note text,
  constraint acme_accounts_org_slug_key unique (org_id, slug)
);
`;
const client = `import { createClient } from '@supabase/supabase-js';\nconst supabase = createClient('https://example.supabase.co', 'anon');\n`;

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'write-contract-')); });
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('WriteContractGate: uneven keys in a bulk write (the field case)', () => {
    const upsert = (rows: string, options = `{ onConflict: 'org_id,slug' }`) => `${client}
export async function sync(orgId: string) {
  return supabase.from('acme_accounts').upsert(${rows}, ${options});
}
`;

    it('flags a NOT NULL column some rows set and others leave out: supabase-js sends it as NULL', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', upsert(`[
    { org_id: orgId, slug: 'north', synced_at: '2026-10-01' },
    { org_id: orgId, slug: 'south' },
  ]`));
        const failures = await run();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ id: 'write-contract', files: ['src/sync.ts'], line: 5, severity: 'high', certainty: 'likely' });
        expect(failures[0].details).toContain("don't all set `synced_at`");
        expect(failures[0].details).toContain('NULL');
        expect(failures[0].hint).toContain('defaultToNull: false');
    });

    it('is clean when every row sets every key', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', upsert(`[
    { org_id: orgId, slug: 'north', synced_at: '2026-10-01' },
    { org_id: orgId, slug: 'south', synced_at: '2026-10-02' },
  ]`));
        expect(await run()).toEqual([]);
    });

    it('is clean with defaultToNull: false when the missing column has a DEFAULT', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', upsert(`[{ org_id: orgId, slug: 'north', synced_at: '2026-10-01' }, { org_id: orgId, slug: 'south' }]`,
            `{ onConflict: 'org_id,slug', defaultToNull: false }`));
        expect(await run()).toEqual([]);
    });

    it('still flags with defaultToNull: false a NOT NULL column with no default', async () => {
        migrate(ACCOUNTS + 'alter table acme_accounts alter column synced_at drop default;');
        write('src/sync.ts', upsert(`[{ org_id: orgId, slug: 'north', synced_at: '2026-10-01' }, { org_id: orgId, slug: 'south' }]`,
            `{ onConflict: 'org_id,slug', defaultToNull: false }`));
        const failures = await run();
        expect(failures.map(f => f.details)).toEqual([expect.stringContaining('`synced_at`, which is NOT NULL with no default')]);
    });

    it('reads rows built by .map with two returns, through a const nothing else touches', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', `${client}
export async function sync(orgId: string, items: { slug: string; at?: string }[]) {
  const rows = items.map(item => {
    if (item.at) return { org_id: orgId, slug: item.slug, synced_at: item.at };
    return { org_id: orgId, slug: item.slug };
  });
  if (rows.length === 0) return;
  await supabase.from('acme_accounts').upsert(rows, { onConflict: 'org_id,slug' });
}
`);
        const failures = await run();
        expect(failures).toHaveLength(1);
        expect(failures[0].line).toBe(10);
        expect(failures[0].lines).toEqual(expect.arrayContaining([5, 6, 7, 10]));
    });

    it('blocks only when the team opts in', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', upsert(`[{ org_id: orgId, slug: 'north', synced_at: '2026-10-01' }, { org_id: orgId, slug: 'south' }]`));
        expect((await run({ block: true }))[0].certainty).toBe('proven');
        expect(await run({ enabled: false })).toEqual([]);
    });
});

describe('WriteContractGate: other writes the database rejects', () => {
    it('flags a NOT NULL column with no default that no row sets', async () => {
        migrate(ACCOUNTS);
        write('src/create.ts', `${client}export const create = (orgId: string) => supabase.from('acme_accounts').insert({ org_id: orgId });\n`);
        const failures = await run();
        expect(failures.map(f => f.details)).toEqual(['This insert into `acme_accounts` never sets column `slug`, which is NOT NULL with no default: the database will reject it.']);
    });

    it('flags a literal outside a CHECK list or an enum, and not one inside', async () => {
        migrate(ACCOUNTS);
        write('src/create.ts', `${client}
export const create = (orgId: string) => supabase.from('acme_accounts').insert({ org_id: orgId, slug: 'north', status: 'archived', plan: 'enterprise' });
export const ok = (orgId: string) => supabase.from('acme_accounts').insert({ org_id: orgId, slug: 'south', status: 'paused', plan: 'team' });
`);
        const details = (await run()).map(f => f.details).sort();
        expect(details).toHaveLength(2);
        expect(details[0]).toContain("sets `plan` to 'enterprise', but its enum type `plan_tier` only allows 'free', 'team'");
        expect(details[1]).toContain("sets `status` to 'archived', but its CHECK constraint `acme_accounts_status_check` only allows 'active', 'paused'");
    });

    it('flags an onConflict target with no unique constraint, and is clean once a unique index covers it', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', `${client}export const sync = (orgId: string) => supabase.from('acme_accounts').upsert({ org_id: orgId, slug: 'north' }, { onConflict: 'slug' });\n`);
        const failures = await run();
        expect(failures.map(f => f.details)).toEqual([expect.stringContaining('resolves conflicts on (`slug`), but no unique constraint or unique index')]);
        migrate('create unique index acme_accounts_slug_idx on public.acme_accounts (slug);', '20260102000000_slug.sql');
        expect(await run()).toEqual([]);
    });

    it('reads a raw SQL insert in a string: its column list, literal values and ON CONFLICT target', async () => {
        migrate(ACCOUNTS);
        write('src/raw.ts', `
export const insertAccount = (db: Db, orgId: string) => db.query(\`
  insert into acme_accounts (org_id, status) values (\${orgId}, 'archived') on conflict (org_id) do nothing\`);
export const fine = (db: Db) => db.query("INSERT INTO acme_accounts (org_id, slug) VALUES ($1, $2) ON CONFLICT (org_id, slug) DO NOTHING");
`);
        const details = (await run()).map(f => f.details).sort();
        expect(details).toEqual([
            expect.stringContaining("sets `status` to 'archived'"),
            expect.stringContaining('The upsert on `acme_accounts` resolves conflicts on (`org_id`)'),
            expect.stringContaining('never sets column `slug`'),
        ]);
    });
});

describe('WriteContractGate: silent wherever it cannot read everything', () => {
    const uneven = `${client}export const sync = (orgId: string) => supabase.from('acme_accounts').upsert([{ org_id: orgId, slug: 'a', synced_at: 'x' }, { org_id: orgId, slug: 'b' }], { onConflict: 'org_id,slug' });\n`;

    it('follows ALTER TABLE in migration order', async () => {
        migrate(ACCOUNTS);
        migrate('alter table public.acme_accounts alter column synced_at drop not null;', '20260102000000_relax.sql');
        write('src/sync.ts', uneven);
        expect(await run()).toEqual([]);
        migrate('alter table acme_accounts alter column synced_at set not null, add column region text not null;', '20260103000000_tighten.sql');
        expect((await run()).map(f => f.details).sort()).toEqual([
            expect.stringContaining("don't all set `synced_at`"),
            expect.stringContaining('never sets column `region`'),
        ]);
    });

    it('says nothing about a table an unparseable migration touches', async () => {
        migrate(ACCOUNTS);
        migrate('alter table acme_accounts attach partition acme_accounts_2026 for values in (2026);', '20260102000000_odd.sql');
        write('src/sync.ts', uneven);
        expect(await run()).toEqual([]);
    });

    it('says nothing about a table a BEFORE INSERT trigger can fill', async () => {
        migrate(ACCOUNTS);
        migrate('create trigger acme_accounts_fill before insert on public.acme_accounts for each row execute function fill_account();', '20260102000000_fill.sql');
        write('src/sync.ts', uneven);
        expect(await run()).toEqual([]);
    });

    it('says nothing when a spread, a computed key or an unknown variable leaves the shape unknown', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', `${client}
export const a = (base: object) => supabase.from('acme_accounts').upsert([{ ...base, slug: 'a', synced_at: 'x' }, { org_id: '1', slug: 'b' }]);
export const b = (key: string) => supabase.from('acme_accounts').insert({ [key]: 'x' });
export const c = (rows: object[]) => supabase.from('acme_accounts').insert(rows);
export const d = () => { const rows = [{ org_id: '1', slug: 'a', synced_at: 'x' }, { org_id: '1', slug: 'b' }]; rows.forEach(r => Object.assign(r, { synced_at: 'y' })); return supabase.from('acme_accounts').upsert(rows); };
`);
        expect(await run()).toEqual([]);
    });

    it('says nothing about a table the migrations do not create, or a key that is not one of its columns', async () => {
        migrate(ACCOUNTS);
        write('src/sync.ts', `${client}
export const a = () => supabase.from('acme_invoices').insert({ total: 1 });
export const b = () => supabase.from('acme_accounts').insert({ org_id: '1', nickname: 'x' });
`);
        expect(await run()).toEqual([]);
    });
});

describe('the write contract in a run\'s summary', () => {
    it('is NOTE, not FAIL, while the gate does not block, and FAIL once it does', async () => {
        migrate(ACCOUNTS);
        write('src/create.ts', `${client}export const create = (orgId: string) => supabase.from('acme_accounts').insert({ org_id: orgId });\n`);
        const summary = async (block: boolean) => (await new GateRunner(ConfigSchema.parse({ version: 1, gates: { write_contract: { block } } })).run(repo, ['src/**/*.ts'])).summary['write-contract'];
        expect(await summary(false)).toBe('NOTE');
        expect(await summary(true)).toBe('FAIL');
    });
});
