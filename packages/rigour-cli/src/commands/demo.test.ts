/**
 * Tests for the demo command — all modes: default, --hooks, --cinematic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { demoCommand } from './demo.js';

describe('demoCommand', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let consoleSpy: any;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should run default demo without errors', async () => {
        await expect(demoCommand({})).resolves.not.toThrow();
    }, 30_000);

    it('should run with --hooks flag', async () => {
        await expect(demoCommand({ hooks: true, speed: 'fast' })).resolves.not.toThrow();

        // Should show hooks simulation
        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('hooks');
    }, 30_000);

    it('should run with --cinematic flag at fast speed', async () => {
        await expect(
            demoCommand({ cinematic: true, speed: 'fast' })
        ).resolves.not.toThrow();

        // Cinematic mode should show the before/after flow
        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('fix');
    }, 60_000);

    it('should produce FAIL status on demo project', async () => {
        await demoCommand({ speed: 'fast' });

        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('FAIL');
    }, 30_000);

    it('should generate fix packet and audit report', async () => {
        await demoCommand({ speed: 'fast' });

        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('Fix packet generated');
        expect(allOutput).toContain('Audit report exported');
    }, 30_000);

    it('should show score bars in output', async () => {
        await demoCommand({ speed: 'fast' });

        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        // Score bars use block characters
        expect(allOutput).toContain('/100');
    }, 30_000);

    it('should show whitepaper link in cinematic closing', async () => {
        await demoCommand({ cinematic: true, speed: 'fast' });

        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('zenodo.org');
    }, 60_000);

    it('should show hooks init command in closing', async () => {
        await demoCommand({ speed: 'fast' });

        const allOutput = consoleSpy.mock.calls.map((c: string[]) => c.join(' ')).join('\n');
        expect(allOutput).toContain('hooks init');
    }, 30_000);
});
