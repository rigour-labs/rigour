import { describe, expect, it } from 'vitest';
import { clusterItems, similarity, statusOf } from './consensus.js';
import { applyPanel, parseAnswers, runPanel, type Answer } from './panel.js';
import type { OpenItem } from './verdict.js';

let n = 0;
const item = (file: string, line: number, cls: string, issue: string, consequence = 'wrong rows'): OpenItem => ({ id: `i${++n}`, kind: 'finding', class: cls, file, line, issue, consequence });
/** Evidence counts only as a real file:line: here, any src/q.ts line. */
const evidenced = (text: string) => /src\/q\.ts:\d+/.test(text);
const members = (judges: string[], items: OpenItem[][]) => clusterItems(judges, items).map(c => c.members.map(m => `${m.judge}:${m.item.issue}`));

describe('matching findings across judges', () => {
    it('needs the same file, and shared wording unless it is the same line and class', () => {
        const a = item('src/a.ts', 10, 'correctness', 'window not bounded at both ends', 'scans every past event');
        expect(similarity(a, { ...a, file: 'src/b.ts' })).toBe(0);
        expect(similarity(a, item('src/a.ts', 11, 'correctness', 'dedupe key changes when the user edits', 'duplicate emails go out'))).toBe(0);
        expect(similarity(a, item('src/a.ts', 10, 'correctness', 'something else entirely', 'duplicate emails go out'))).toBeGreaterThanOrEqual(0.5);
    });

    it('keeps two different findings on adjacent lines apart, even listed in a misleading order (first-fit by line would cross them)', () => {
        const judgeA = [item('src/q.ts', 10, 'production-cost', 'time window not bounded at both ends'), item('src/q.ts', 11, 'correctness', 'dedupe key changes when the user edits')];
        const judgeB = [item('src/q.ts', 10, 'correctness', 'dedupe key built from updated_at changes when the user edits'), item('src/q.ts', 11, 'production-cost', 'read window has no upper bound at either end')];
        expect(members(['a', 'b'], [judgeA, judgeB])).toEqual([
            ['a:time window not bounded at both ends', 'b:read window has no upper bound at either end'],
            ['a:dedupe key changes when the user edits', 'b:dedupe key built from updated_at changes when the user edits'],
        ]);
    });

    it('matches one bug two judges cite at different lines', () => {
        const judgeA = [item('src/q.ts', 10, 'correctness', 'lock is checked after the first read of rows')];
        const judgeB = [item('src/q.ts', 40, 'correctness', 'the first read of rows happens before the lock is checked')];
        expect(members(['a', 'b'], [judgeA, judgeB])).toHaveLength(1);
    });

    it('puts what one judge split under the one item another judge wrote', () => {
        const judgeA = [item('src/q.ts', 10, 'production-cost', 'both reads, rows and cards, are unbounded')];
        const judgeB = [item('src/q.ts', 10, 'production-cost', 'rows read is unbounded'), item('src/q.ts', 14, 'production-cost', 'cards read is unbounded')];
        expect(members(['a', 'b'], [judgeA, judgeB])).toEqual([['a:both reads, rows and cards, are unbounded', 'b:rows read is unbounded', 'b:cards read is unbounded']]);
    });

    it('never merges one judge\'s own two findings, however close', () => {
        const judgeA = [item('src/x.ts', 10, 'correctness', 'session.user may be null when the token expired'), item('src/x.ts', 12, 'correctness', 'session.expires compared as a string, not a date')];
        expect(members(['a', 'b'], [judgeA, []])).toEqual([['a:session.user may be null when the token expired'], ['a:session.expires compared as a string, not a date']]);
    });

    it('groups three judges, and is the same every run', () => {
        const items = [
            [item('src/q.ts', 10, 'correctness', 'lock checked after the read')],
            [item('src/q.ts', 11, 'correctness', 'the read happens before the lock is checked'), item('src/r.ts', 3, 'dead-code', 'export unused')],
            [item('src/q.ts', 10, 'correctness', 'lock checked only after the read')],
        ];
        const once = members(['a', 'b', 'c'], items);
        expect(once).toEqual(members(['a', 'b', 'c'], items));
        expect(once.map(c => c.length)).toEqual([3, 1]);
    });
});

describe('deciding a finding', () => {
    it('confirms on a strict majority, drops on evidence against with nobody unsure, else disputes', () => {
        expect(statusOf({ a: 'raised', b: 'raised' }, 2)).toBe('confirmed');
        expect(statusOf({ a: 'raised', b: 'confirm' }, 2)).toBe('confirmed');
        expect(statusOf({ a: 'raised', b: 'refute' }, 2)).toBe('dropped');
        expect(statusOf({ a: 'raised', b: 'unsure' }, 2)).toBe('disputed');
        expect(statusOf({ a: 'raised', b: 'raised' }, 3)).toBe('confirmed');
        expect(statusOf({ a: 'raised', b: 'confirm', c: 'refute' }, 3)).toBe('confirmed');
        expect(statusOf({ a: 'raised', b: 'refute', c: 'refute' }, 3)).toBe('dropped');
        expect(statusOf({ a: 'raised', b: 'refute', c: 'unsure' }, 3)).toBe('disputed');
    });

    it('asks each judge once about what it did not raise, needs file:line evidence, and caps what it asks', async () => {
        const asked: Record<string, string[]> = {};
        const lone = item('src/q.ts', 10, 'correctness', 'lock checked after the read');
        const refuted = item('src/q.ts', 30, 'correctness', 'the cursor skips the last page');
        const bare = item('src/q.ts', 50, 'correctness', 'an index is missing on created_at');
        const overCap = item('src/z.ts', 1, 'correctness', 'retries forever on 429');
        const answers: Record<string, Answer[]> = { b: [{ id: lone.id, call: 'confirm', evidence: 'src/q.ts:12 reads before lock()' }, { id: refuted.id, call: 'refute', evidence: 'src/q.ts:33 the loop runs once more' }, { id: bare.id, call: 'confirm' }] };
        const decided = await runPanel({
            judges: ['a', 'b'], items: [[lone, refuted, bare, overCap], []], previousDisputed: [], touched: new Set(), maxItems: 3, evidenced,
            ask: async (judge, items) => { asked[judge] = items.map(i => i.issue); return answers[judge] ?? []; },
        });
        expect(asked).toEqual({ b: ['lock checked after the read', 'the cursor skips the last page', 'an index is missing on created_at'] });
        const status = Object.fromEntries(decided.map(d => [d.item.issue, d.status]));
        expect(status).toEqual({ 'lock checked after the read': 'confirmed', 'the cursor skips the last page': 'dropped', 'an index is missing on created_at': 'disputed', 'retries forever on 429': 'disputed' });
        expect(decided.find(d => d.item.id === overCap.id)?.note).toContain('panel_max_items');
        expect(decided.find(d => d.item.id === lone.id)).toMatchObject({ judges: ['a'], calls: { a: 'raised', b: 'confirm' }, cross: [{ by: 'b', call: 'confirm', evidence: 'src/q.ts:12 reads before lock()' }] });
    });

    it('does not ask again about a finding disputed before on a file nothing has touched since', async () => {
        const again = item('src/q.ts', 10, 'correctness', 'lock checked after the read');
        const asked: string[] = [];
        const ask = async (_judge: string, items: OpenItem[]) => { asked.push(...items.map(i => i.id)); return []; };
        const untouched = await runPanel({ judges: ['a', 'b'], items: [[again], []], previousDisputed: [{ ...again, id: 'old' }], touched: new Set(), maxItems: 20, evidenced, ask });
        expect(untouched[0]).toMatchObject({ status: 'disputed', note: 'disputed before; its file is unchanged since' });
        expect(asked).toEqual([]);
        await runPanel({ judges: ['a', 'b'], items: [[again], []], previousDisputed: [{ ...again, id: 'old' }], touched: new Set(['src/q.ts']), maxItems: 20, evidenced, ask });
        expect(asked).toEqual([again.id]);
    });

    it('a judge that fails to answer leaves the findings disputed, never confirmed', async () => {
        const lone = item('src/q.ts', 10, 'correctness', 'lock checked after the read');
        const decided = await runPanel({ judges: ['a', 'b'], items: [[lone], []], previousDisputed: [], touched: new Set(), maxItems: 20, evidenced, ask: async () => { throw new Error('timed out'); } });
        expect(decided[0]).toMatchObject({ status: 'disputed', calls: { a: 'raised', b: 'unsure' } });
    });
});

describe('the panel in the accounting', () => {
    it('blocks only on what it confirmed, and lists the rest', () => {
        const confirmed = item('src/q.ts', 10, 'correctness', 'lock checked after the read');
        const disputed = item('src/q.ts', 30, 'correctness', 'cursor skips a page');
        const human = { ...item('', 0, 'prior point', 'a human point'), kind: 'prior' as const };
        const result = applyPanel({ open: [confirmed, disputed, human] }, new Set([confirmed.id, disputed.id]), [
            { item: confirmed, judges: ['a', 'b'], calls: { a: 'raised', b: 'raised' }, status: 'confirmed' },
            { item: disputed, judges: ['a'], calls: { a: 'raised', b: 'unsure' }, status: 'disputed' },
        ]);
        expect(result.open.map(i => i.issue)).toEqual(['a human point', 'lock checked after the read']);
        expect(result.open[1].reviewer).toBe('a+b');
        expect(result.disputed.map(i => i.issue)).toEqual(['cursor skips a page']);
    });

    it('reads the answers out of a reply with prose around them, and nothing from a reply without them', () => {
        expect(parseAnswers('Checked.\n```json\n{"answers":[{"id":"x","call":"refute","evidence":"a.ts:3"},{"id":"y","call":"maybe"}]}\n```')).toEqual([{ id: 'x', call: 'refute', evidence: 'a.ts:3' }]);
        expect(parseAnswers('I could not decide.')).toEqual([]);
    });
});
