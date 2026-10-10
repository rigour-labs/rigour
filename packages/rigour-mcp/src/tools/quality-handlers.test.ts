import { describe, expect, it, vi } from 'vitest';
import { handleCheck, handleGetFixPacket } from './quality-handlers.js';

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

    it('runs standard check on the files when no config is given', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const runner = { run } as any;

        await handleCheck(runner, '/repo');

        expect(run).toHaveBeenCalledWith('/repo', undefined, undefined);
    });

    it('judges the agent\'s change by the stop hook\'s rule when no files are named', async () => {
        const run = vi.fn();
        const review = vi.fn().mockResolvedValue({ blocking: [{ id: 'hallucinated-imports' }], result: { advisory: [{}], fileFindings: [], preexisting: 4, report: null }, against: 'main @ abc1234', diff: '' });
        const result = await handleCheck({ run } as any, '/repo', {}, { gates: {} } as any, review);
        expect(run).not.toHaveBeenCalled(); // scope "change" is the default
        expect(review).toHaveBeenCalledWith('/repo', { gates: {} });
        expect(result.content[0].text).toContain('FAIL: 1 thing to fix in your change (against main @ abc1234)');
        expect(result.content[0].text).toContain('Not yours: 4 issue(s) the code already had');
    });

    it('audits the whole repository when asked for scope "repo"', async () => {
        const run = vi.fn().mockResolvedValue(baseReport);
        const review = vi.fn();
        await handleCheck({ run } as any, '/repo', { scope: 'repo' }, { gates: {} } as any, review);
        expect(run).toHaveBeenCalledWith('/repo', undefined, undefined);
        expect(review).not.toHaveBeenCalled();
    });

    it('maps quick deep mode and file scope', async () => {
        const run = vi.fn().mockResolvedValue({
            ...baseReport,
            stats: {
                ...baseReport.stats,
                deep: { enabled: true, tier: 'lite', model: 'Qwen2.5-Coder-0.5B' },
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

describe('handleGetFixPacket pagination', () => {
    const review = vi.fn().mockResolvedValue({
        blocking: Array.from({ length: 12 }, (_, index) => ({ id: 'file-size', title: `Finding ${index}`, details: `Detail ${index}`, files: [`src/file-${index}.ts`], severity: 'low' })),
        result: { advisory: [], fileFindings: [] }, against: 'main @ abc1234', diff: '',
    });
    const config = { gates: { safety: {} }, commands: {} } as any;

    it('returns a small first page and a precise continuation offset', async () => {
        const result = await handleGetFixPacket('/repo', config, {}, review);
        expect(result.content[0].text).toContain('MUST FIX 1/12');
        expect(result.content[0].text).toContain('offset=5 and limit=5');
        expect(result.content[0].text).not.toContain('Finding 5');
    });

    it('rejects invalid pagination before reviewing', async () => {
        review.mockClear();
        const result = await handleGetFixPacket('/repo', config, { limit: 11 }, review);
        expect(result.isError).toBe(true);
        expect(review).not.toHaveBeenCalled();
    });
});
