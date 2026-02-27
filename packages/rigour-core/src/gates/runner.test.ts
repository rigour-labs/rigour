import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GateRunner } from './runner.js';
import { DeepAnalysisGate } from './deep-analysis.js';

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

    it('reports local deep tier when provider=local even with apiKey', async () => {
        vi.spyOn(DeepAnalysisGate.prototype, 'run').mockResolvedValue([]);
        const runner = createRunner();

        const report = await runner.run(testDir, undefined, {
            enabled: true,
            apiKey: 'sk-test',
            provider: 'local',
            pro: false,
        });

        expect(report.stats.deep?.tier).toBe('deep');
        expect(report.stats.deep?.model).toBe('Qwen2.5-Coder-0.5B');
    });

    it('reports local pro tier when provider=local and pro=true', async () => {
        vi.spyOn(DeepAnalysisGate.prototype, 'run').mockResolvedValue([]);
        const runner = createRunner();

        const report = await runner.run(testDir, undefined, {
            enabled: true,
            apiKey: 'sk-test',
            provider: 'local',
            pro: true,
        });

        expect(report.stats.deep?.tier).toBe('pro');
        expect(report.stats.deep?.model).toBe('Qwen2.5-Coder-1.5B');
    });

    it('reports cloud tier/model for cloud providers', async () => {
        vi.spyOn(DeepAnalysisGate.prototype, 'run').mockResolvedValue([]);
        const runner = createRunner();

        const report = await runner.run(testDir, undefined, {
            enabled: true,
            apiKey: 'sk-test',
            provider: 'openai',
            modelName: 'gpt-4.1-mini',
            pro: false,
        });

        expect(report.stats.deep?.tier).toBe('cloud');
        expect(report.stats.deep?.model).toBe('gpt-4.1-mini');
    });
});
