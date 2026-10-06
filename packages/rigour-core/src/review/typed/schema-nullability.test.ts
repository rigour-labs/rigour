import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadSchemaNullability, tableKey, type SchemaNullability } from './schema-nullability.js';

/** The migrations as numbered files in a folder of their own, replayed. */
const replay = (...migrations: string[]): SchemaNullability => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
    try {
        migrations.forEach((sql, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}_step.sql`), sql));
        return loadSchemaNullability(dir, ['.']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};
const columns = (schema: SchemaNullability, table: string) => Object.fromEntries(schema.get(tableKey(table)) ?? []);

describe('NOT NULL columns from migrations', () => {
    it('reads column definitions, primary keys and quoted names, ignoring strings, comments and CHECK text', () => {
        const schema = replay(`
-- a comment; with a semicolon
create table if not exists public.study_set (
    id uuid primary key default gen_random_uuid(),
    "OwnerId" uuid not null references auth.users(id),
    title text default 'not null' ,
    archived_at timestamptz check (archived_at is not null or title is null),
    kind text NOT NULL,
    /* block; comment */
    constraint study_set_title_unique unique (title)
);`);
        expect(columns(schema, 'study_set')).toEqual({ id: true, OwnerId: true, title: false, archived_at: false, kind: true });
    });

    it('follows ALTER TABLE in file order: add, set and drop NOT NULL, rename, drop column, rename table', () => {
        const schema = replay(
            'create table app.card (id bigint, set_id bigint, body text);',
            `alter table only app.card add column if not exists due_at timestamptz not null default now(),
                alter column set_id set not null, add constraint card_pk primary key (id);`,
            'alter table app.card alter column body set not null; alter table app.card alter column body drop not null;',
            'alter table app.card rename column due_at to next_due_at; alter table app.card drop column if exists body;',
            'alter table app.card rename to flashcard;',
        );
        expect(schema.has(tableKey('app.card'))).toBe(false);
        expect(columns(schema, 'app.flashcard')).toEqual({ id: true, set_id: true, next_due_at: true });
    });

    it('keeps a function body whole and treats tables it cannot read as unknown', () => {
        const schema = replay(
            `create function touch() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
             create table copy as select * from other;
             create table part partition of parent for values in (1);
             create table gone (id int not null); drop table if exists gone cascade;`,
        );
        expect(schema.get(tableKey('copy'))).toBeNull();
        expect(schema.get(tableKey('part'))).toBeNull();
        expect(schema.has(tableKey('gone'))).toBe(false);
    });

    it('loads every folder named, in file-name order across them, skipping one that does not exist', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
        try {
            fs.mkdirSync(path.join(root, 'a'));
            fs.mkdirSync(path.join(root, 'b'));
            fs.writeFileSync(path.join(root, 'b', '20240101_create.sql'), 'create table t (id int, note text);');
            fs.writeFileSync(path.join(root, 'a', '20240202_tighten.sql'), 'alter table t alter column note set not null;');
            fs.writeFileSync(path.join(root, 'a', 'README.md'), 'not sql');
            const schema = loadSchemaNullability(root, ['a', path.join(root, 'b'), 'missing']);
            expect(columns(schema, 't')).toEqual({ id: false, note: true });
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
