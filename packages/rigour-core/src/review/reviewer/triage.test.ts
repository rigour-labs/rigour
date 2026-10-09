import { describe, expect, it } from 'vitest';
import { costGuard, SPECIALISTS } from './orchestrator.js';
import { parseHunks, planPasses, slice, triage } from './triage.js';

/** One pass's size limit (triage.ts MAX_PASS_DIFF_CHARS). */
const PASS_LIMIT = 120_000;

/** A diff adding `lines` to `file` (a new file when `fresh`), or removing them with `removed`. */
function diff(file: string, lines: string[], options: { fresh?: boolean; removed?: string[] } = {}): string {
    const header = `diff --git a/${file} b/${file}\n${options.fresh ? 'new file mode 100644\n--- /dev/null\n' : `--- a/${file}\n`}+++ b/${file}\n`;
    const body = [...(options.removed ?? []).map(l => `-${l}`), ...lines.map(l => `+${l}`)].join('\n');
    return `${header}@@ -1,${options.removed?.length ?? 0} +1,${lines.length} @@\n${body}\n`;
}
const none = { humanReviews: 0, rulesAndLessons: 0, goal: false };
const picks = (d: string, context = none) => [...triage(parseHunks(d), context).keys()].sort();

describe('triage', () => {
    it('picks production cost for reads in every language it knows, and for migrations and indexes', () => {
        const reads: Array<[string, string]> = [
            ['src/a.ts', "const rows = await db.query('select id from orders where shop = $1', [shop]);"],
            ['src/b.js', 'const users = await prisma.user.findMany({ take: 50 });'],
            ['src/c.ts', 'const { data } = await supabase.from("lessons").select("id").range(0, 99);'],
            ['src/d.ts', 'for (const id of ids) { const row = await load(id); }'],
            ['app/e.py', 'rows = cursor.execute("SELECT * FROM orders WHERE id = %s", (order_id,))'],
            ['app/f.py', 'items = Order.objects.filter(shop=shop).all()'],
            ['svc/g.go', 'rows, err := db.QueryContext(ctx, "SELECT id FROM orders WHERE shop = $1", shop)'],
            ['db/h.sql', 'SELECT id FROM orders WHERE created_at > now() - interval \'1 day\';'],
            ['migrations/2026_10_09_add_index.sql', 'CREATE INDEX orders_shop_idx ON orders (shop);'],
            ['db/migrate/20261009_orders.rb', 'add_index :orders, :shop'],
            ['prisma/schema.prisma', '  @@index([shop])'],
        ];
        for (const [file, line] of reads) expect(picks(diff(file, [line])), file).toContain('production-cost');
    });

    it('picks no production cost for code that reads nothing', () => {
        expect(picks(diff('src/a.ts', ['const total = items.reduce((sum, i) => sum + i.price, 0);']))).not.toContain('production-cost');
    });

    it('picks correctness for code, cleanup for deletions, declarations and new files, and leaves tests, docs and lockfiles out of both', () => {
        expect(picks(diff('src/a.ts', ['const x = 1;']))).toEqual(['correctness']);
        expect(picks(diff('src/a.ts', ['const x = 2;'], { removed: ['const x = 1;'] }))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('src/a.ts', ['export function total() {}']))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('src/new.ts', ['const x = 1;'], { fresh: true }))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('src/a.test.ts', ['expect(1).toBe(1);']))).toEqual([]);
        expect(picks(diff('pnpm-lock.yaml', ['lockfileVersion: 9']))).toEqual([]);
        expect(picks(diff('src/api.gen.ts', ['export const x = 1;']))).toEqual([]);
    });

    it('picks rules and goal for docs, comments, served rules or lessons, and the goal; prior points only with a human review', () => {
        expect(picks(diff('docs/guide.md', ['Every link goes through the helper.']))).toEqual(['rules-and-goal']);
        expect(picks(diff('src/a.ts', ['// at most one email per run']))).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, rulesAndLessons: 2 })).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, goal: true })).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, humanReviews: 1 })).toEqual(['correctness', 'prior-points']);
        expect(picks(diff('pnpm-lock.yaml', ['x']), { ...none, humanReviews: 1 })).toEqual(['prior-points']);
    });
});

describe('a pass\'s slice', () => {
    it('is its hunks, and every other hunk that defines a name they use', () => {
        const hunks = parseHunks(diff('src/a.ts', ['const total = sumOrders(orders);']) + diff('src/b.ts', ['export function sumOrders(orders) { return 0; }']) + diff('src/c.ts', ['const unrelated = 1;']));
        const part = slice(hunks, [0]);
        expect(part).toContain('src/a.ts');
        expect(part).toContain('export function sumOrders');
        expect(part).not.toContain('src/c.ts');
    });
});

describe('the pass plan', () => {
    const big = (file: string, line: string) => diff(file, Array.from({ length: Math.ceil(PASS_LIMIT / line.length) + 10 }, () => line));

    it('is one combined pass for every picked part when it fits, and no pass when nothing is picked', () => {
        const hunks = parseHunks(diff('src/a.ts', ["const rows = await db.query('select 1');"], { removed: ['const x = 1;'] }));
        const plan = planPasses(hunks, triage(hunks, { ...none, humanReviews: 1 }), SPECIALISTS);
        expect(plan.map(p => p.specialists)).toEqual([['prior-points', 'correctness', 'production-cost', 'cleanup']]);
        expect(planPasses(parseHunks(diff('pnpm-lock.yaml', ['x'])), new Map(), SPECIALISTS)).toEqual([]);
    });

    it('splits past one pass\'s size into at most three passes, never more than it picked, and stays one when the guard says so', () => {
        const hunks = parseHunks(big('src/a.ts', "const rows = await db.query('select id from orders');") + big('docs/guide.md', 'The loader pages by cursor.'));
        const picked = triage(hunks, { ...none, humanReviews: 1 });
        const plan = planPasses(hunks, picked, SPECIALISTS);
        expect(plan.length).toBeGreaterThan(1);
        expect(plan.length).toBeLessThanOrEqual(Math.min(3, picked.size));
        expect(plan.flatMap(p => p.specialists).sort()).toEqual([...picked.keys()].sort());
        expect(planPasses(hunks, picked, SPECIALISTS, true)).toHaveLength(1);
    });
});

describe('the cost guard', () => {
    it('allows one run per review without single-review history', () => {
        expect(costGuard([])).toMatchObject({ combinedOnly: true, why: expect.stringContaining('no single-review cost') });
    });

    it('keeps one pass when orchestrated reviews cost more per changed line than one judge, and allows a split otherwise', () => {
        const single = Array.from({ length: 5 }, () => ({ mode: 'single' as const, lines: 100, usd: 1 }));
        expect(costGuard([...single, { mode: 'orchestrator', lines: 100, usd: 3 }])).toMatchObject({ combinedOnly: true, why: expect.stringContaining('$0.0300 per changed line, one judge $0.0100') });
        expect(costGuard([...single, { mode: 'orchestrator', lines: 100, usd: 0.8 }])).toMatchObject({ combinedOnly: false });
    });
});
