import { describe, expect, it } from 'vitest';
import { findReads } from './queries.js';

const reads = (code: string) => findReads('a.ts', code);

describe('findReads', () => {
    it('models a literal supabase-js read: filters, first order column, line', () => {
        const [read] = reads(`
const page = await supabase
  .from('orders')
  .select('id, placed_at')
  .eq('status', 'open')
  .not('customer_id', 'is', null)
  .gt('placed_at', since)
  .lte('placed_at', until)
  .order('placed_at')
  .order('id')
  .limit(100);`);
        expect(read).toEqual({
            table: 'orders', line: 3, uncertain: false, orderBy: 'placed_at',
            filters: [
                { column: 'status', op: 'eq', value: 'open' },
                { column: 'customer_id', op: 'notnull' },
                { column: 'placed_at', op: 'range' },
                { column: 'placed_at', op: 'range' },
            ],
        });
    });

    it('reads .in, .is(null), .match and .filter, and qualifies a non-public schema', () => {
        const [read] = reads(`db.schema('billing').from('invoices').select('*').in('id', ids).is('paid_at', null).match({ kind: 'card' }).filter('total', 'gte', 10);`);
        expect(read.table).toBe('billing.invoices');
        expect(read.filters).toEqual([
            { column: 'id', op: 'in' },
            { column: 'paid_at', op: 'isnull' },
            { column: 'kind', op: 'eq', value: 'card' },
            { column: 'total', op: 'range' },
        ]);
        expect(read.uncertain).toBe(false);
    });

    it('is uncertain when anything is computed, OR-ed, embedded or unknown', () => {
        const uncertain = [
            `db.from(table).select('*').eq('a', 1);`,
            `db.from('t').select('*').eq(column, 1);`,
            `db.from('t').select('*').or('a.eq.1,b.eq.2');`,
            `db.from('t').select('*, u!inner(*)').eq('u.id', 1);`,
            `db.from('t').select('*').someNewFilter('a', 1);`,
            `db.schema(name).from('t').select('*').eq('a', 1);`,
        ];
        expect(uncertain.map(code => reads(code)[0].uncertain)).toEqual(uncertain.map(() => true));
    });

    it('ignores writes and calls that are not reads', () => {
        expect(reads(`db.from('t').insert({ a: 1 }).select();`)).toEqual([]);
        expect(reads(`db.from('t').update({ a: 1 }).eq('id', 1);`)).toEqual([]);
        expect(reads(`Array.from(items).filter(Boolean);`)).toEqual([]);
    });
});
