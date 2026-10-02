import { describe, expect, it } from 'vitest';
import { policyColumns, policyFilters, replayMigrations } from './schema.js';
import { splitStatements } from './sql.js';

describe('splitStatements', () => {
    it('keeps comments, quotes and dollar bodies from splitting a statement', () => {
        const sql = `-- a; comment\ncreate table a (x text default ';');\n/* b; */ do $$ begin perform 1; end $$;\nselect 'it''s; fine';`;
        expect(splitStatements(sql)).toEqual(["create table a (x text default ';')", 'do $$ begin perform 1; end $$', "select 'it''s; fine'"]);
    });
});

describe('replayMigrations', () => {
    it('collects primary keys, unique columns and table constraints as indexes', () => {
        const schema = replayMigrations([`
            create table public.orders (
              id uuid primary key default gen_random_uuid(),
              code text not null unique,
              customer_id uuid not null references customers(id),
              placed_at timestamptz,
              constraint orders_customer_code unique (customer_id, code)
            );`]);
        expect(schema.get('orders')!.indexes.map(i => i.leading)).toEqual(['id', 'code', 'customer_id']);
        expect(schema.get('orders')!.uncertain).toBe(false);
    });

    it('applies indexes, partial predicates, drops and renames in order', () => {
        const schema = replayMigrations([
            'create table orders (id uuid primary key, status text, placed_at timestamptz, customer_id uuid);',
            `create index concurrently orders_open_idx on public.orders (placed_at desc, id) where status = 'open' and customer_id is not null;`,
            'create index orders_customer_idx on orders using btree (customer_id);',
            'create index orders_lower_idx on orders (lower(status));',
            'drop index if exists public.orders_customer_idx;',
            'alter index orders_open_idx rename to orders_open_v2_idx;',
        ]);
        const indexes = schema.get('orders')!.indexes;
        expect(indexes.map(i => [i.name, i.leading])).toEqual([[undefined, 'id'], ['orders_open_v2_idx', 'placed_at'], ['orders_lower_idx', null]]);
        expect(indexes[1].predicate).toEqual([{ kind: 'eq', column: 'status', value: 'open' }, { kind: 'notnull', column: 'customer_id' }]);
    });

    it('follows ALTER TABLE: added keys, table renames, dropped tables', () => {
        const schema = replayMigrations([
            'create table events (id bigint, kind text);',
            'alter table events add constraint events_pkey primary key (id);',
            'alter table events add column ref text unique;',
            'alter table events rename to audit_events;',
            'create table scratch (x int);',
            'drop table scratch;',
        ]);
        expect(schema.get('audit_events')!.indexes.map(i => i.leading)).toEqual(['id', 'ref']);
        expect([...schema.keys()]).toEqual(['audit_events']);
    });

    it('marks a table uncertain when DDL is beyond what it models', () => {
        const schema = replayMigrations([
            'create table a (id int, x int); create table b (id int); create table c (like a including indexes); create table d (id int) partition by range (id);',
            'alter table a rename column x to y;',
            `create or replace function f() returns void language plpgsql as $$ begin create index on b (id); end $$;`,
        ]);
        expect(['a', 'b', 'c', 'd'].map(t => schema.get(t)!.uncertain)).toEqual([true, true, true, true]);
    });

    it('treats an OR or an unreadable predicate as unknown', () => {
        const schema = replayMigrations([
            'create table t (a int, b int);',
            `create index t_or on t (a) where a = 1 or b = 2;`,
            `create index t_fn on t (a) where coalesce(b, 0) > 0;`,
        ]);
        expect(schema.get('t')!.indexes.map(i => i.predicate)).toEqual([[{ kind: 'unknown' }], [{ kind: 'unknown' }]]);
    });

    it('keeps SELECT and ALL policies as the columns they compare to the user', () => {
        const schema = replayMigrations([
            'create table subs (id text primary key, user_id uuid, status text);',
            `create policy "own" on subs for select using (auth.uid() = user_id);`,
            `create policy "writes" on subs for insert with check (auth.uid() = user_id);`,
            `create policy "all" on subs to authenticated using (true);`,
        ]);
        expect(policyFilters(schema.get('subs')!)).toEqual({ columns: ['user_id'], unknown: false });
    });
});

describe('policyColumns', () => {
    it('reads comparisons to the current user and gives up on anything else', () => {
        expect(policyColumns('(select auth.uid()) = owner_id')).toEqual(['owner_id']);
        expect(policyColumns('(owner_id = auth.uid()) or (editor_id = auth.uid())')).toEqual(['owner_id', 'editor_id']);
        expect(policyColumns('true')).toEqual([]);
        expect(policyColumns('exists (select 1 from members m where m.org_id = org_id)')).toBeNull();
    });
});
