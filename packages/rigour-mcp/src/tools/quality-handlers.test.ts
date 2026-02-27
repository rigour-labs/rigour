import { describe, expect, it, vi } from 'vitest';
import { handleCheck } from './quality-handlers.js';

describe('handleCheck deep routing', () => {
    const baseReport = {
        status: 'PASS',
        summary: { 'ast-analysis': 'PASS' },
        failures: [],
        stats: {
            duration_ms: 10,
            score: 100,
            ai_health_score: 100,
            structural_score: 100,
        },
    } as any;

    it('runs standard check by default', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;

        await handleCheck(runner, '/repo');

        expect(run).toHaveBeenCalledWith('/repo', undefined, undefined);
    });

    it('maps quick deep mode and file scope', async () => {
        const run = vi.fn().mockResolvedValue({
            ...baseReport,
            stats: {
                ...baseReport.stats,
                deep: { enabled: true, tier: 'deep', model: 'Qwen2.5-Coder-0.5B' },
            },
        });
        const runner = { run } as any;

        const result = await handleCheck(runner, '/repo', {
            deep: 'quick',
            files: ['src/a.ts', 'src/b.ts'],
        });

        expect(run).toHaveBeenCalledWith('/repo', ['src/a.ts', 'src/b.ts'], {
            enabled: true,
            pro: false,
            apiKey: undefined,
            provider: 'local',
            apiBaseUrl: undefined,
            modelName: undefined,
        });
        expect(result.content[0].text).toContain('Deep: quick');
        expect(result.content[0].text).toContain('Execution: local');
        expect(result.content[0].text).toContain('Code remains on this machine');
    });

    it('maps full deep mode with cloud provider', async () => {
        const run = vi.fn().mockResolvedValue({
            ...baseReport,
            stats: {
                ...baseReport.stats,
                deep: { enabled: true, tier: 'cloud', model: 'claude-sonnet' },
            },
        });
        const runner = { run } as any;

        await handleCheck(runner, '/repo', {
            deep: 'full',
            pro: true,
            apiKey: 'sk-test',
            provider: 'openai',
            modelName: 'gpt-4o-mini',
            apiBaseUrl: 'https://example.com/v1',
        });

        expect(run).toHaveBeenCalledWith('/repo', undefined, {
            enabled: true,
            pro: true,
            apiKey: 'sk-test',
            provider: 'openai',
            apiBaseUrl: 'https://example.com/v1',
            modelName: 'gpt-4o-mini',
        });
    });

    it('treats full deep mode as pro even when pro flag is omitted', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;

        await handleCheck(runner, '/repo', {
            deep: 'full',
            apiKey: 'sk-test',
            provider: 'openai',
        });

        expect(run).toHaveBeenCalledWith('/repo', undefined, {
            enabled: true,
            pro: true,
            apiKey: 'sk-test',
            provider: 'openai',
            apiBaseUrl: undefined,
            modelName: undefined,
        });
    });

    it('forces local execution when provider=local even if apiKey is present', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;

        const result = await handleCheck(runner, '/repo', {
            deep: 'full',
            apiKey: 'sk-test',
            provider: 'local',
        });

        expect(run).toHaveBeenCalledWith('/repo', undefined, {
            enabled: true,
            pro: true,
            apiKey: 'sk-test',
            provider: 'local',
            apiBaseUrl: undefined,
            modelName: undefined,
        });
        expect(result.content[0].text).toContain('Execution: local');
        expect(result.content[0].text).toContain('Code remains on this machine');
    });
});
