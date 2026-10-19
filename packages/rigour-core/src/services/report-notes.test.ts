import { describe, expect, it } from 'vitest';
import { ReportSchema } from '../types/index.js';
import { blockingGates, reportNotes } from './report-notes.js';

const NOTE = { id: 'write-contract', title: 'Write the database will reject', details: 'x', files: ['src/a.ts'], line: 3 };
const FAIL = { id: 'hallucinated-imports', title: 'Hallucinated Imports', details: 'y' };
const report = { summary: { 'write-contract': 'NOTE', 'hallucinated-imports': 'FAIL' } as const, failures: [NOTE, FAIL, FAIL] };

describe('notes in a report', () => {
    it('keeps a gate whose findings are notes out of the failed gates, and lists its findings as notes', () => {
        expect(blockingGates(report)).toEqual(['hallucinated-imports']);
        expect(reportNotes(report)).toEqual([NOTE]);
    });

    it('lets only a gate summary be NOTE, never the run', () => {
        const run = { status: 'PASS', summary: { 'write-contract': 'NOTE' }, failures: [NOTE], stats: { duration_ms: 1 } };
        expect(ReportSchema.safeParse(run).success).toBe(true);
        expect(ReportSchema.safeParse({ ...run, status: 'NOTE' }).success).toBe(false);
    });
});
