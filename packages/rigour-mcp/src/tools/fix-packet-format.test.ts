import { describe, expect, it } from 'vitest';
import { formatFixPacketPage } from './fix-packet-format.js';

describe('formatFixPacketPage', () => {
    it('keeps a large Fix Packet bounded and exposes every page', () => {
        const violations = Array.from({ length: 2_319 }, (_, index) => ({
            id: 'hallucinated-imports',
            gate: 'hallucinated-imports',
            severity: 'high',
            title: `Finding ${index}`,
            details: 'Long evidence '.repeat(1_000),
            locations: Array.from({ length: 100 }, (_, location) => ({ file: `src/file-${location}.ts`, line: location + 1 })),
            instructions: ['Inspect the real module', 'Fix the import'],
        }));
        const packet = {
            violations,
            failed_gates: ['hallucinated-imports'],
            constraints: { allowed_scope: Array.from({ length: 2_319 }, (_, i) => `src/file-${i}.ts`) },
            verification: { commands: [{ cmd: 'rigour_check', purpose: 'Verify the changes' }] },
        } as any;
        const report = { stats: { score: 6 } } as any;

        const first = formatFixPacketPage(packet, report, 0, 10);
        const second = formatFixPacketPage(packet, report, 10, 10);

        expect(first.length).toBeLessThan(24_000);
        expect(first).toContain('FIX 1/2319');
        expect(first).toContain('next_offset: 10');
        expect(first).toContain('offset=10 and limit=10');
        expect(first).not.toContain('Finding 10');
        expect(second).toContain('FIX 11/2319');
        expect(second).not.toContain('Finding 0');
        expect(formatFixPacketPage(packet, report, 2_318, 10)).toContain('End of Fix Packet');
        expect(formatFixPacketPage(packet, report, 9_999, 10)).toContain('Page: 2319-2319 of 2319');
    });
});
