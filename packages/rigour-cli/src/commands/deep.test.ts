import { afterEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
    prepare: vi.fn(),
    findEngine: vi.fn(),
    getCachedModel: vi.fn(),
    tiers: [] as string[],
}));
vi.mock('@rigour-labs/core', () => ({
    SidecarProvider: class {
        constructor(tier: string) { core.tiers.push(tier); }
        prepare = core.prepare;
        findEngine = core.findEngine;
    },
    getCachedModel: core.getCachedModel,
}));

const { deepPullCommand } = await import('./deep.js');

describe('rigour deep pull', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        core.tiers.length = 0;
    });

    it('prepares the lite tier by default and reports what it installed', async () => {
        core.prepare.mockResolvedValue(undefined);
        core.findEngine.mockResolvedValue({ path: '/home/.rigour/bin/llama-b5604/llama-cli', version: '5604' });
        core.getCachedModel.mockResolvedValue({ info: { name: 'Qwen2.5-Coder-0.5B-Instruct (stock)' } });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        expect(await deepPullCommand(false)).toBe(0);
        expect(core.tiers).toEqual(['lite']);
        expect(log.mock.calls.flat().join('\n')).toContain('llama.cpp 5604');
        expect(log.mock.calls.flat().join('\n')).toContain('Qwen2.5-Coder-0.5B-Instruct (stock)');
    });

    it('prepares the deep tier with --pro', async () => {
        core.prepare.mockResolvedValue(undefined);
        core.findEngine.mockResolvedValue(null);
        core.getCachedModel.mockResolvedValue(null);
        vi.spyOn(console, 'log').mockImplementation(() => undefined);

        await deepPullCommand(true);
        expect(core.tiers).toEqual(['deep']);
    });

    it('exits 3 with the reason when the engine or model cannot be installed', async () => {
        core.prepare.mockRejectedValue(new Error('HTTP 404 for https://github.com/...'));
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(await deepPullCommand(false)).toBe(3);
        expect(error.mock.calls.flat().join('\n')).toContain('HTTP 404');
    });
});
