import { describe, expect, it, vi } from 'vitest';
import { handleCheckDeep } from './deep-handlers.js';

describe('handleCheckDeep privacy routing', () => {
    const baseReport = {
        status: 'PASS',
        summary: { 'ast-analysis': 'PASS' },
        failures: [],
        stats: {
            duration_ms: 10,
            score: 100,
            ai_health_score: 100,
            structural_score: 100,
            deep: { enabled: true, tier: 'deep', model: 'Qwen2.5-Coder-0.5B', total_ms: 1000 },
        },
    } as any;

    it('reports local execution by default', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;
        const result = await handleCheckDeep(runner, '/repo', {} as any, {});

        expect(run).toHaveBeenCalledWith('/repo', undefined, {
            enabled: true,
            pro: false,
            apiKey: undefined,
            provider: 'local',
            apiBaseUrl: undefined,
            modelName: undefined,
        });
        expect(result.content[0].text).toContain('Local sidecar/model execution');
    });

    it('respects provider=local even when apiKey exists', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;
        const result = await handleCheckDeep(runner, '/repo', {} as any, {
            apiKey: 'sk-test',
            provider: 'local',
        });

        expect(run).toHaveBeenCalledWith('/repo', undefined, {
            enabled: true,
            pro: false,
            apiKey: 'sk-test',
            provider: 'local',
            apiBaseUrl: undefined,
            modelName: undefined,
        });
        expect(result.content[0].text).toContain('Local sidecar/model execution');
        expect(result.content[0].text).not.toContain('Code context may be sent');
    });
});
