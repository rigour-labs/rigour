import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../inference/types.js';

const provider = vi.hoisted(() => ({
    setup: vi.fn(async () => undefined),
    analyze: vi.fn(async (_prompt: string) => '{"findings": []}'),
}));
vi.mock('../inference/index.js', () => ({
    createProvider: (): InferenceProvider => ({
        name: 'fake',
        isAvailable: async () => true,
        setup: provider.setup,
        analyze: provider.analyze,
        dispose: () => undefined,
    }),
}));
vi.mock('../storage/local-memory.js', () => ({ checkLocalPatterns: async () => [] }));

const { DeepAnalysisGate } = await import('./deep-analysis.js');

const REPORT_TS = [
    'export async function loadReport(days: number) {',
    '  const rows = await fetchAll(days);',
    '  return rows.length;',
    '}',
].join('\n');

describe('DeepAnalysisGate', () => {
    let cwd: string;

    beforeEach(async () => {
        cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-deep-gate-'));
        await fs.outputFile(path.join(cwd, 'src/report.ts'), REPORT_TS);
        await fs.outputFile(path.join(cwd, 'src/other.ts'), 'export const other = 1;\nexport const two = 2;\nexport const three = 3;\n');
        provider.setup.mockReset().mockResolvedValue(undefined);
        provider.analyze.mockReset().mockResolvedValue('{"findings": []}');
    });
    afterEach(async () => { await fs.remove(cwd); });

    const gate = () => new DeepAnalysisGate({ options: { enabled: true, provider: 'local' } });

    it('records an error outcome when setup fails', async () => {
        provider.setup.mockRejectedValue(new Error('engine missing'));
        const g = gate();
        expect(await g.run({ cwd })).toEqual([]);
        expect(g.getOutcome()).toMatchObject({ status: 'error', error: 'engine missing' });
    });

    it('records an error outcome when every inference call fails', async () => {
        provider.analyze.mockRejectedValue(new Error('invalid argument: --json'));
        const g = gate();
        await g.run({ cwd, patterns: ['src/report.ts', 'src/other.ts'] });
        expect(g.getOutcome()).toMatchObject({ status: 'error', chunksTotal: 2, chunksFailed: 2 });
        expect(g.getOutcome().error).toContain('invalid argument: --json');
    });

    it('records a partial outcome when some calls fail', async () => {
        provider.analyze.mockRejectedValueOnce(new Error('timed out')).mockResolvedValue('{"findings": []}');
        const g = gate();
        await g.run({ cwd, patterns: ['src/report.ts', 'src/other.ts'] });
        expect(g.getOutcome()).toMatchObject({ status: 'partial', chunksTotal: 2, chunksFailed: 1 });
    });

    it('reviews only the scoped file, with its numbered source', async () => {
        const g = gate();
        await g.run({ cwd, patterns: ['src/report.ts'] });
        expect(provider.analyze).toHaveBeenCalledTimes(1);
        const prompt = provider.analyze.mock.calls[0][0];
        expect(prompt).toContain('2|   const rows = await fetchAll(days);');
        expect(prompt).not.toContain('src/other.ts');
        expect(g.getOutcome()).toMatchObject({ status: 'ok', mode: 'code', filesAnalyzed: 1 });
    });

    it('keeps grounded findings and drops ones about code that was not sent', async () => {
        provider.analyze.mockResolvedValue(JSON.stringify({ findings: [
            { category: 'scalability', severity: 'high', file: 'src/report.ts', line: 2, description: '`fetchAll` loads every row.', suggestion: 'Aggregate in SQL.', confidence: 0.8 },
            { category: 'security', severity: 'high', file: 'src/report.ts', line: 3, description: '`sendSecret` leaks a token.', suggestion: 'x', confidence: 0.9 },
        ] }));
        const failures = await gate().run({ cwd, patterns: ['src/report.ts'] });
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ id: 'deep-analysis', files: ['src/report.ts'], line: 2, provenance: 'deep-analysis', verified: true });
    });

    it('uses the facts prompt for an unscoped run', async () => {
        const g = gate();
        await g.run({ cwd });
        expect(provider.analyze.mock.calls[0][0]).toContain('AST-EXTRACTED FACTS');
        expect(g.getOutcome()).toMatchObject({ status: 'ok', mode: 'facts', filesAnalyzed: 2 });
    });

    it('is ok with no analyzable files in scope', async () => {
        const g = gate();
        expect(await g.run({ cwd, patterns: ['README.md'] })).toEqual([]);
        expect(g.getOutcome()).toMatchObject({ status: 'ok', filesAnalyzed: 0 });
        expect(provider.analyze).not.toHaveBeenCalled();
    });
});
