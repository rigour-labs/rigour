import { describe, expect, it } from 'vitest';
import { buildRecord, recordIntact, recordLines, type RecordInput } from './record.js';
import type { OpenItem, Verdict } from './verdict.js';

const item = (over: Partial<OpenItem>): OpenItem => ({ id: 'i1', kind: 'finding', class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', quote: 'return 1;', ...over });
const input = (): RecordInput => ({
    head: 'abcdef0123456789', base: '0123456789abcdef', scope: 'full',
    verdict: { prior_points: [], redundant: [], reads: [], scans: [], merge_impact: [], findings: [], carried: [], resolved_previous: [],
        rules: [{ id: 'r1', status: 'followed' }, { id: 'r2', status: 'broken' }, { id: 'r3', status: 'not-applicable' }], lessons: [{ lesson: 'bound the window', applies: true }, { lesson: 'keyset', applies: false }] } as unknown as Verdict,
    accounted: { open: [item({}), item({ id: 'p1', kind: 'prior', class: 'prior point', issue: 'take the lock' })], advisory: [item({ id: 's1', issue: 'could log the id' })], unverified: [item({ id: 'u1' })], notes: [item({ id: 'n1' }), item({ id: 'n2' })], resolved: [{ item: item({ id: 'old' }), evidence: 'fixed' }], answerInReply: [], disputed: [], dismissed: [item({ id: 'd1' })] },
    judges: [{ reviewer: 'claude', version: '2.1.0', model: 'opus', cost_usd: 1.25, turns: 19 }],
    lessonsServed: 4, humanReviews: 2, at: '2026-10-08T00:00:00Z',
});

describe('the review record', () => {
    it('counts what was verified, what was reported and what people decided, and hashes it', () => {
        const record = buildRecord(input());
        expect(record.verified).toMatchObject({ rules: { served: 3, followed: 1, broken: 1, not_applicable: 1 }, lessons: { served: 4, applied: 1 }, prior_points: { open: 1, resolved: 1, answer_in_reply: 0 }, unverified: 1, notes: 2, disputed: 0 });
        expect(record.verified.blocking).toHaveLength(2);
        expect(record.verified.should_fix).toHaveLength(1);
        expect(record).toMatchObject({ reported: { human_reviews: 2 }, people: { dismissed: 1 }, judges: [{ reviewer: 'claude', turns: 19 }] });
        expect(record.integrity).toMatch(/^[0-9a-f]{64}$/);
        expect(buildRecord(input()).integrity).toBe(record.integrity); // the same review hashes the same
        expect(recordIntact(record)).toBe(true);
        expect(recordIntact({ ...record, verified: { ...record.verified, blocking: [] } })).toBe(false); // a block removed after the fact shows
    });

    it('renders for a pull request: blocks in full, a few should-fixes, the counts, the judges and the hash', () => {
        const lines = recordLines(buildRecord(input()), 1);
        expect(lines[0]).toBe('**Review record** · 2 blocking · 1 should-fix · rules 1 followed, 1 broken, 1 not applicable of 3 · lessons 1 of 4 apply · prior points 1 open, 1 resolved');
        expect(lines).toContain('- **Blocking** `src/job.ts:2` returns before the lock');
        expect(lines).toContain('- Should fix: `src/job.ts:2` could log the id');
        expect(lines.at(-2)).toBe('Also seen, never blocking: 2 working notes, 1 unverified, 1 dismissed.');
        expect(lines.at(-1)).toMatch(/^Judged by claude 2\.1\.0 \(opus\) \$1\.25 on `abcdef012` against `012345678` \(full\); 2 human review\(s\) seen\. Integrity `[0-9a-f]{16}`\.$/);
    });

    it("counts the prior points that took the review's own severity label, and only when the reviews carry labels", () => {
        const labelled = input();
        labelled.accounted = { ...labelled.accounted, labels: { served: 4, taken: 2, disagreed: 1 } };
        const record = buildRecord(labelled);
        expect(record.verified.prior_points).toMatchObject({ labelled: 2, relabelled: 1 });
        expect(recordLines(record).join('\n')).toContain("2 by the review's own label (1 relabelled)");
        expect(buildRecord(input()).verified.prior_points).not.toHaveProperty('labelled');
    });
});
