import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateRunner } from './runner.js';
import { DeepAnalysisGate, type DeepRunOutcome } from './deep-analysis.js';
import { ConfigSchema, type Failure } from '../types/index.js';
import { execFileSync } from 'child_process';
import { renderFullReport } from '../services/terminal-renderer.js';
import { NO_GIT_BASE } from './logic-drift-git-base.js';

function mockDeep(outcome: Partial<DeepRunOutcome>, failures: Failure[] = []) {
    vi.spyOn(DeepAnalysisGate.prototype, 'run').mockResolvedValue(failures);
    vi.spyOn(DeepAnalysisGate.prototype, 'getOutcome').mockReturnValue({
        status: 'ok', mode: 'facts', filesAnalyzed: 1, chunksTotal: 1, chunksFailed: 0, ...outcome,
    });
}

describe('GateRunner deep stats execution mode', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-runner-deep-'));
        await fs.writeFile(path.join(testDir, 'index.ts'), 'export const ok = true;\n');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(testDir);
    });

    function createRunner() {
        return new GateRunner({
            version: 1,
            commands: {},
            gates: {
                max_file_lines: 500,
                forbid_todos: true,
                forbid_fixme: true,
            },
        } as any);
    }

    it('reports local lite tier and the model the provider actually loaded', async () => {
        mockDeep({ model: 'Qwen2.5-Coder-0.5B-Instruct (stock)', modelFallback: true });

        const report = await createRunner().run(testDir, undefined, {
            enabled: true, apiKey: 'sk-test', provider: 'local', pro: false,
        });

        expect(report.stats.deep?.tier).toBe('lite');
        expect(report.stats.deep?.model).toBe('Qwen2.5-Coder-0.5B-Instruct (stock)');
        expect(report.stats.deep?.model_fallback).toBe(true);
        expect(report.stats.deep?.status).toBe('ok');
        expect(report.summary['deep-analysis']).toBe('PASS');
    });

    it('reports local deep tier when provider=local and pro=true', async () => {
        mockDeep({ model: 'Rigour-Deep-v5.0.0 (Qwen2.5-Coder-1.5B fine-tuned)', modelFallback: false });

        const report = await createRunner().run(testDir, undefined, {
            enabled: true, apiKey: 'sk-test', provider: 'local', pro: true,
        });

        expect(report.stats.deep?.tier).toBe('deep');
        expect(report.stats.deep?.model).toBe('Rigour-Deep-v5.0.0 (Qwen2.5-Coder-1.5B fine-tuned)');
    });

    it('reports cloud tier/model for cloud providers', async () => {
        mockDeep({ model: 'gpt-4.1-mini' });

        const report = await createRunner().run(testDir, undefined, {
            enabled: true, apiKey: 'sk-test', provider: 'openai', modelName: 'gpt-4.1-mini', pro: false,
        });

        expect(report.stats.deep?.tier).toBe('cloud');
        expect(report.stats.deep?.model).toBe('gpt-4.1-mini');
    });

    it('reports a deep run that could not analyze anything as ERROR with a visible failure', async () => {
        mockDeep({ status: 'error', chunksTotal: 3, chunksFailed: 3, error: 'All 3 inference call(s) failed.' });

        const report = await createRunner().run(testDir, undefined, { enabled: true, pro: false });

        expect(report.summary['deep-analysis']).toBe('ERROR');
        expect(report.status).toBe('FAIL');
        expect(report.stats.deep).toMatchObject({ status: 'error', chunks_total: 3, chunks_failed: 3, error: 'All 3 inference call(s) failed.' });
        const failure = report.failures.find(f => f.id === 'deep-analysis');
        expect(failure?.title).toBe('Deep analysis did not run');
        expect(failure?.details).toContain('All 3 inference call(s) failed.');
    });

    it('keeps a partial run as PASS/FAIL by findings and records failed chunks', async () => {
        mockDeep({ status: 'partial', chunksTotal: 4, chunksFailed: 1 });

        const report = await createRunner().run(testDir, undefined, { enabled: true, pro: false });

        expect(report.summary['deep-analysis']).toBe('PASS');
        expect(report.stats.deep).toMatchObject({ status: 'partial', chunks_total: 4, chunks_failed: 1 });
    });
});

describe('a check that cannot compare', () => {
    it('reports SKIP with its reason, in the summary, the JSON and the rendered report, never PASS', async () => {
        const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-runner-skip-'));
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        try {
            git('init', '-q', '-b', 'dev'); // no main or master: nothing to compare with
            git('config', 'user.email', 't@example.com');
            git('config', 'user.name', 't');
            git('config', 'commit.gpgsign', 'false');
            await fs.writeFile(path.join(repo, 'a.py'), 'def load_rows():\n    return []\n');
            git('add', '-A');
            git('commit', '-qm', 'x');
            const report = await new GateRunner(ConfigSchema.parse({ version: 1 })).run(repo);
            expect([report.summary['style-drift'], report.summary['logic-drift']]).toEqual(['SKIP', 'SKIP']);
            expect(report.skips).toEqual({ 'style-drift': NO_GIT_BASE, 'logic-drift': NO_GIT_BASE });
            expect(JSON.parse(JSON.stringify(report)).skips['logic-drift']).toContain('nothing to compare with');
            expect(renderFullReport(report)).toContain(`logic-drift skipped: ${NO_GIT_BASE}`);

            git('branch', 'main'); // with a main branch they compare, and pass
            const compared = await new GateRunner(ConfigSchema.parse({ version: 1 })).run(repo);
            expect([compared.summary['style-drift'], compared.summary['logic-drift'], compared.skips]).toEqual(['PASS', 'PASS', undefined]);
        } finally {
            await fs.remove(repo);
        }
    }, 60_000);
});
