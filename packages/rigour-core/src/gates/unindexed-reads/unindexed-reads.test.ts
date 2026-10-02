import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnindexedReadsGate } from './index.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const run = (config = { enabled: true }) => new UnindexedReadsGate(config).run({ cwd: repo, patterns: ['src/**/*.ts'] });

const TABLE = `create table orders (
  id uuid primary key,
  customer_id uuid,
  status text not null,
  placed_at timestamptz,
  campaign_id uuid
);
create index orders_customer_idx on orders (customer_id, status, placed_at desc);
create index orders_campaign_window_idx on orders (placed_at, id) where status = 'open' and campaign_id is not null;
`;

const WINDOW_READ = `
export async function openOrders(db: Db, since: string, until: string) {
  return db
    .from('orders')
    .select('id, placed_at')
    .eq('status', 'open')
    .not('customer_id', 'is', null)
    .gt('placed_at', since)
    .lte('placed_at', until)
    .order('placed_at')
    .order('id');
}
`;

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unindexed-')); });
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('UnindexedReadsGate', () => {
    it('flags a window read whose only candidate index is partial on a filter the read does not have', async () => {
        write('supabase/migrations/20260101000000_orders.sql', TABLE);
        write('src/orders.ts', WINDOW_READ);
        const failures = await run();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ id: 'unindexed-reads', files: ['src/orders.ts'], line: 4 });
        expect(failures[0].details).toContain('`orders`');
        expect(failures[0].details).toContain('`placed_at`');
    });

    it('is silent once a later migration adds an index that serves the read', async () => {
        write('supabase/migrations/20260101000000_orders.sql', TABLE);
        write('supabase/migrations/20260102000000_orders_open.sql',
            `create index concurrently orders_open_window_idx on public.orders (placed_at, id) where status = 'open' and customer_id is not null;`);
        write('src/orders.ts', WINDOW_READ);
        expect(await run()).toEqual([]);
    });

    it('is silent for a primary-key lookup, a table outside the migrations, and an uncertain table', async () => {
        write('db/migrations/001_orders.sql', TABLE + 'create table notes (id int, body text);\nalter table notes rename column body to text;\n');
        write('src/reads.ts', `
          db.from('orders').select('*').eq('id', id);
          db.from('auth_users').select('*').eq('email', email);
          db.from('notes').select('*').eq('text', q);
        `);
        expect(await run()).toEqual([]);
    });

    it('is silent unless enabled, and for a read that narrows nothing', async () => {
        write('supabase/migrations/20260101000000_orders.sql', TABLE);
        write('src/orders.ts', WINDOW_READ + `\ndb.from('orders').select('*').limit(10);\n`);
        expect(await run({ enabled: false })).toEqual([]);
        expect(await new UnindexedReadsGate({ enabled: true }).run({ cwd: repo, patterns: ['src/**/*.ts'] })).toHaveLength(1);
    });

    it('needs every migration set that defines the table to lack a serving index', async () => {
        write('apps/a/supabase/migrations/1_orders.sql', TABLE);
        write('apps/b/supabase/migrations/1_orders.sql', TABLE + `create index orders_status_idx on orders (status);`);
        write('src/orders.ts', WINDOW_READ);
        expect(await run()).toEqual([]);
    });

    it('counts a row-level policy as a filter: names its column, and is silent once that column is indexed', async () => {
        const subs = `create table subs (id text primary key, user_id uuid not null, status text);
create policy "own subs" on subs for select using (auth.uid() = user_id);`;
        write('supabase/migrations/1_subs.sql', subs);
        write('src/subs.ts', `export const active = (db: Db) => db.from('subs').select('*').in('status', ['active']).maybeSingle();\n`);
        const [finding] = await run();
        expect(finding.details).toContain('`user_id`');

        write('supabase/migrations/2_subs_user.sql', 'create index subs_user_idx on subs (user_id);');
        expect(await run()).toEqual([]);
    });

    it('is silent for a table whose policy it cannot read', async () => {
        write('supabase/migrations/1_docs.sql', `create table docs (id int primary key, org_id int, title text);
create policy "members" on docs for select using (exists (select 1 from members m where m.org_id = docs.org_id));`);
        write('src/docs.ts', `db.from('docs').select('*').eq('title', t);\n`);
        expect(await run()).toEqual([]);
    });
});

