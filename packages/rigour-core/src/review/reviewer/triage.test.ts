import { describe, expect, it } from 'vitest';
import { ledger, passLimit, SPECIALISTS, splitNeeds } from './orchestrator.js';
import type { ReviewCost } from './store.js';
import { parseHunks, planPasses, reviewable, triage } from './triage.js';

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

    it('picks no production cost for code that reads nothing, in each language', () => {
        const quiet: Array<[string, string[]]> = [
            ['src/a.ts', ['const first = items.find(i => i.id === id);', 'const all = Array.from(seen);', 'const kept = rows.filter(Boolean);', 'const v = cache.get(key);', 'const limit = 3;']],
            ['src/b.ts', ['for (const item of items) {', '  total += item.price;', '  count++;', '  seen.add(item.id);', '}', 'const result = await save(total);']],
            ['app/c.py', ['value = settings.get("timeout")', 'names = [u.name for u in users if u.active]']],
            ['svc/d.go', ['v := m.Get("key")', 'for _, x := range xs { total += x }']],
            ['src/e.ts', ["const label = 'Please select one option';"]],
        ];
        for (const [file, lines] of quiet) expect(picks(diff(file, lines)), file).not.toContain('production-cost');
    });

    it('picks correctness for every file a model can review, in any language, tests and docs folders included', () => {
        const files: Array<[string, string]> = [
            ['src/parse.c', 'int n = len + 1;'], ['include/parse.h', 'int parse(char *s);'], ['scripts/deploy.sh', 'rm -rf "$DIR"'],
            ['Dockerfile', 'FROM node:22'], ['.github/workflows/ci.yml', 'run: npm test'], ['infra/main.tf', 'count = 2'],
            ['config/app.json', '"retries": 3'], ['src/a.test.ts', 'expect(total).toBe(3);'], ['src/gen/router.ts', 'export const route = 1;'],
            ['src/key-gen.ts', 'export const key = 1;'], ['packages/docs/src/build.ts', 'export const build = 1;'],
        ];
        for (const [file, line] of files) expect(picks(diff(file, [line])), file).toContain('correctness');
    });

    it('skips only lockfiles, snapshots, maps, minified bundles and files a generator marks as its own', () => {
        for (const file of ['pnpm-lock.yaml', 'go.sum', 'src/__snapshots__/a.test.ts.snap', 'dist/app.min.js', 'dist/app.js.map', 'src/__generated__/schema.ts', 'src/api.generated.ts', 'proto/order.pb.go', 'app/order_pb2.py']) {
            expect(picks(diff(file, ['x = 1'])), file).toEqual([]);
        }
    });

    it('picks cleanup for deletions, declarations and new files, and prose only for the rules and the goal', () => {
        expect(picks(diff('src/a.ts', ['const x = 1;']))).toEqual(['correctness']);
        expect(picks(diff('src/a.ts', ['const x = 2;'], { removed: ['const x = 1;'] }))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('src/a.ts', ['export function total() {}']))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('src/new.ts', ['const x = 1;'], { fresh: true }))).toEqual(['cleanup', 'correctness']);
        expect(picks(diff('docs/guide.md', ['Every link goes through the helper.']))).toEqual(['rules-and-goal']);
    });

    it('picks rules and goal for comments, served rules or lessons, and the goal; prior points only with a human review', () => {
        expect(picks(diff('src/a.ts', ['// at most one email per run']))).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, rulesAndLessons: 2 })).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, goal: true })).toEqual(['correctness', 'rules-and-goal']);
        expect(picks(diff('src/a.ts', ['const x = 1;']), { ...none, humanReviews: 1 })).toEqual(['correctness', 'prior-points']);
        expect(picks(diff('pnpm-lock.yaml', ['x']), { ...none, humanReviews: 1 })).toEqual(['prior-points']); // open human points are checked whatever changed
    });
});

describe('the pass plan', () => {
    /** `n` hunks in their own files, each about `size` characters of code that reads. */
    const many = (n: number, size: number) => Array.from({ length: n }, (_, i) => diff(`src/f${i}.ts`, Array.from({ length: Math.ceil(size / 60) }, (_, j) => `const r${j} = await db.query('select ${j} from t${i}');`))).join('');

    it('is exactly one pass, whatever it picked, for a change that fits; none when nothing is picked', () => {
        const hunks = parseHunks(diff('src/a.ts', ["const rows = await db.query('select 1');", '// one read per run'], { removed: ['const x = 1;'] }));
        const plan = planPasses(hunks, triage(hunks, { humanReviews: 1, rulesAndLessons: 1, goal: true }), SPECIALISTS, 120_000);
        expect(plan.split).toBeUndefined();
        expect(plan.combined?.specialists).toEqual(['prior-points', 'correctness', 'production-cost', 'cleanup', 'rules-and-goal']);
        expect(planPasses(parseHunks(diff('pnpm-lock.yaml', ['x'])), new Map(), SPECIALISTS, 120_000)).toEqual({});
    });

    it('gives a pass its hunks and every other hunk that defines a name they use', () => {
        const hunks = parseHunks(diff('src/a.ts', ['const total = sumOrders(orders);']) + diff('src/b.ts', ['export function sumOrders(orders) { return 0; }']) + diff('src/c.ts', ['const unrelated = 1;']));
        const plan = planPasses(hunks, new Map([['correctness', [0]]]), SPECIALISTS, 120_000);
        expect(plan.combined?.sliced).toEqual([0, 1]);
        expect(plan.combined?.diff).not.toContain('src/c.ts');
    });

    it('splits a change over the limit by hunk, every part within the limit, every picked hunk in exactly one part', () => {
        const limit = 20_000;
        const hunks = parseHunks(many(12, 5_000));
        const picked = triage(hunks, none);
        const plan = planPasses(hunks, picked, SPECIALISTS, limit);
        expect(plan.combined!.diff.length).toBeGreaterThan(limit);
        expect(plan.split!.length).toBeGreaterThan(1);
        for (const pass of plan.split!) expect(pass.diff.length).toBeLessThanOrEqual(limit);
        expect(plan.split!.flatMap(p => p.hunks)).toEqual(plan.combined!.hunks);
        expect(plan.split!.reduce((sum, p) => sum + p.diff.length, 0)).toBe(plan.combined!.diff.length);
    });

    it('holds a pass to the judge in use: one diff, two judges with different limits, two plans', () => {
        const timeout = 15 * 60_000;
        expect(passLimit('api', timeout)).toBeLessThan(passLimit('claude', timeout));
        expect(passLimit('claude', 60_000)).toBeLessThan(passLimit('claude', timeout)); // the timeout bounds it too
        const hunks = parseHunks(many(30, 10_000));
        const picked = triage(hunks, none);
        const size = planPasses(hunks, picked, SPECIALISTS, Infinity).combined!.diff.length;
        expect(size).toBeGreaterThan(passLimit('api', timeout));
        expect(size).toBeLessThanOrEqual(passLimit('claude', timeout));
        expect(planPasses(hunks, picked, SPECIALISTS, passLimit('claude', timeout)).split).toBeUndefined();
        expect(planPasses(hunks, picked, SPECIALISTS, passLimit('api', timeout)).split!.length).toBeGreaterThan(1);
    });

    it('measures both modes on the reviewable diff only', () => {
        const hunks = parseHunks(diff('src/a.ts', ['const x = 1;']) + diff('pnpm-lock.yaml', Array.from({ length: 500 }, (_, i) => `pkg${i}: 1`)));
        expect(reviewable(hunks).lines).toBe(1);
    });
});

describe('the savings ledger', () => {
    const row = (mode: ReviewCost['mode'], single: number, actual: number, usd = 0): ReviewCost => ({ at: '', mode, lines: 1, projectedSingleChars: single, actualChars: actual, actualUsd: usd, runs: 1 });

    it('is empty without orchestrated history, and sums what one judge would have been given minus what every run was', () => {
        expect(ledger([], undefined)).toEqual({ credit: 0, unit: 'chars' });
        expect(ledger([row('single', 900, 900), row('orchestrator', 1000, 0), row('orchestrator', 1000, 1200)], undefined)).toEqual({ credit: 800, unit: 'chars' });
    });

    it('counts in dollars once the baseline prices a character, a run without dollars priced at the baseline', () => {
        const baseline = { at: '', usdPerChar: 0.001, singles: 5 };
        expect(ledger([row('orchestrator', 1000, 0), row('orchestrator', 1000, 1000, 0.5)], baseline).credit).toBeCloseTo(1.5);
        expect(splitNeeds(3000, 2000, 'usd', baseline)).toBeCloseTo(1);
    });

    it('forgets credit older than the last twenty orchestrated reviews', () => {
        const old = Array.from({ length: 5 }, () => row('orchestrator', 10_000, 0));
        const recent = Array.from({ length: 20 }, () => row('orchestrator', 1000, 1000));
        expect(ledger([...old, ...recent], undefined).credit).toBe(0);
    });
});
