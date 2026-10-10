import { describe, expect, it } from 'vitest';
import type { ChangeReview, Failure } from '@rigour-labs/core';
import { formatFixPacketPage } from './fix-packet-format.js';

const finding = (n: number, over: Partial<Failure> = {}): Failure => ({
    id: 'hallucinated-imports', title: `Finding ${n}`, details: 'Long evidence '.repeat(1_000), severity: 'high', files: [`src/file-${n}.ts`], line: n + 1, hint: 'Fix the import', ...over,
} as Failure);

const review = (blocking: Failure[], notes: Failure[]): ChangeReview => ({
    blocking, against: 'main @ abc1234', diff: '',
    result: { advisory: notes, fileFindings: [] } as never,
});

describe('formatFixPacketPage', () => {
    it('puts what blocks the agent first, under its own heading, with the exact place, and keeps every page bounded', () => {
        const packet = review([finding(0), finding(1)], Array.from({ length: 30 }, (_, n) => finding(n + 2, { id: 'promise-safety', severity: 'critical', certainty: 'likely' })));
        const first = formatFixPacketPage(packet, 0, 10);
        expect(first.length).toBeLessThan(24_000);
        expect(first).toContain('Your change, against main @ abc1234: 2 must fix (blocks you), 30 notes (optional).');
        expect(first).toContain('Fix every must-fix item');
        expect(first.indexOf('MUST FIX (blocks you)')).toBeLessThan(first.indexOf('━━━ MUST FIX 1/2'));
        expect(first).toContain('WHERE: src/file-0.ts:1');
        expect(first.indexOf('NOTES (optional)')).toBeGreaterThan(first.indexOf('━━━ MUST FIX 2/2'));
        expect(first).toContain('━━━ NOTE 1/30: [MEDIUM]'); // a likely critical note is shown at most medium
        expect(first).toContain('certainty: likely');
        expect(first).toContain('offset=10 and limit=10');
        const later = formatFixPacketPage(packet, 10, 10);
        expect(later).toContain('NOTES (optional)');
        expect(later).not.toContain('MUST FIX (blocks you)');
        expect(formatFixPacketPage(packet, 30, 10)).toContain('End of the packet');
    });

    it('says plainly when nothing blocks', () => {
        expect(formatFixPacketPage(review([], []), 0, 5)).toContain('0 must fix (blocks you), 0 notes (optional).');
    });
});
