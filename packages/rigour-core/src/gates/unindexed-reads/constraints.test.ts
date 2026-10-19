import { describe, expect, it } from 'vitest';
import { columnConstraints, tableConstraint } from './constraints.js';
import { replayMigrations } from './schema.js';
import { replayContracts } from '../write-contract/contracts.js';

describe('tableConstraint and columnConstraints: the one reading of keys both replays use', () => {
    it('reads a table key with or without a space before its list, quoted names as written, and DEFERRABLE', () => {
        expect(tableConstraint('unique(org_id,slug)', 'public.acme_sites')).toEqual({ kind: 'unique', name: 'acme_sites_org_id_slug_key', columns: ['org_id', 'slug'], deferrable: false });
        expect(tableConstraint('constraint "K" UNIQUE("OrgId", "Slug") DEFERRABLE INITIALLY DEFERRED', 'acme_sites'))
            .toEqual({ kind: 'unique', name: 'K', columns: ['OrgId', 'Slug'], deferrable: true });
        expect(tableConstraint('primary key(a,b) not deferrable', 'acme_sites')).toMatchObject({ kind: 'primary key', name: 'acme_sites_pkey', deferrable: false });
        expect(tableConstraint('constraint k unique using index acme_sites_slug_idx', 'acme_sites')).toMatchObject({ name: 'k', usingIndex: 'acme_sites_slug_idx' });
        expect(tableConstraint('exclude using gist (during with &&)', 'acme_sites')).toMatchObject({ kind: 'exclude', name: 'acme_sites_during_excl' });
        expect(tableConstraint('check (a > 0)', 'acme_sites')).toBeUndefined();
    });

    it('reads a column\'s keys and references, each with its own name and DEFERRABLE', () => {
        expect(columnConstraints('text not null constraint s_key unique deferrable references acme_orgs(id)', 'acme_sites', 'Slug')).toEqual([
            { kind: 'unique', name: 's_key', columns: ['Slug'], deferrable: true },
            { kind: 'foreign key', name: 'acme_sites_Slug_fkey', columns: ['Slug'], deferrable: false },
        ]);
    });

    it('gives both replays the same constraint names, so a dropped no-space key is understood by both', () => {
        const sql = ['create table acme_sites (id uuid primary key, org_id uuid, slug text, unique(org_id, slug));', 'alter table acme_sites drop constraint acme_sites_org_id_slug_key;'];
        expect(replayMigrations(sql).get('acme_sites')!.indexes.map(i => i.keys)).toEqual([['id']]);
        expect(replayContracts(sql).tables.get('acme_sites')!.unknown).toBe(false);
    });
});
