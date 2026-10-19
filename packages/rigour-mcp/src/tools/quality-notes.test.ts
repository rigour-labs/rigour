import { describe, expect, it, vi } from 'vitest';
import { handleCheck, handleExplain } from './quality-handlers.js';

const NOTE = {
    id: 'write-contract', title: 'Write the database will reject', severity: 'high', files: ['src/sync.ts'], line: 3, certainty: 'likely',
    details: "Rows in this insert into `acme_jobs` don't all set `ran_at`; supabase-js sends the key as NULL for the ones that don't, and `ran_at` is NOT NULL: the database will reject the whole batch.",
    hint: 'Set `ran_at` in every row.',
};
const report = (status: 'PASS' | 'FAIL', failures: object[], summary: Record<string, string>) =>
    ({ status, summary, failures, stats: { duration_ms: 5, score: 95, ai_health_score: 100, structural_score: 100 } }) as any;
const runner = (r: object) => ({ run: vi.fn().mockResolvedValue(r) }) as any;
const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;

describe('notes over MCP: the agent sees what does not block', () => {
    it('rigour_check says the gates passed with notes, and lists each with file and line', async () => {
        const out = text(await handleCheck(runner(report('PASS', [NOTE], { 'write-contract': 'NOTE' })), '/repo', { scope: 'repo' }));
        expect(out).toContain('ALL GATES PASSED (1 note, not blocking)');
        expect(out).toContain("- [write-contract] src/sync.ts:3: Rows in this insert into `acme_jobs` don't all set `ran_at`");
        expect(out).toContain('- write-contract: NOTE');
    });

    it('rigour_check keeps notes out of a failing run\'s count and lists them after', async () => {
        const blocking = { id: 'hallucinated-imports', title: 'Hallucinated Imports', severity: 'high', details: 'x', files: ['src/a.ts'] };
        const out = text(await handleCheck(runner(report('FAIL', [blocking, NOTE], { 'write-contract': 'NOTE', 'hallucinated-imports': 'FAIL' })), '/repo', { scope: 'repo' }));
        expect(out).toContain('1 violations');
        expect(out).toContain('Also 1 note, not blocking:\n- [write-contract] src/sync.ts:3:');
    });

    it('rigour_explain explains the notes of a passing run instead of saying there is nothing to explain', async () => {
        const out = text(await handleExplain(runner(report('PASS', [NOTE], { 'write-contract': 'NOTE' })), '/repo'));
        expect(out).not.toContain('No failures to explain');
        expect(out).toContain('1 note, not blocking');
        expect(out).toContain('1. [NOTE] [WRITE-CONTRACT] src/sync.ts:3: Rows in this insert');
        expect(out).toContain('(Hint: Set `ran_at` in every row.)');
        expect(text(await handleExplain(runner(report('PASS', [], {})), '/repo'))).toContain('No failures to explain');
    });
});
