import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import fs from 'fs-extra';
import path from 'path';

async function getCheckCommand() {
    const { checkCommand } = await import('./commands/check.js');
    return checkCommand;
}

describe('CLI Smoke Test', () => {
    const testDir = path.join(process.cwd(), 'temp-smoke-test');

    beforeEach(async () => {
        await fs.ensureDir(testDir);
        // @ts-ignore
        vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(async () => {
        try {
            const restrictedDir = path.join(testDir, '.restricted');
            if (await fs.pathExists(restrictedDir)) {
                await fs.chmod(restrictedDir, 0o777);
            }
            await fs.remove(testDir);
        } catch (e) {
            // Best effort cleanup
        }
        vi.restoreAllMocks();
    });

    it('should respect ignore patterns and avoid EPERM', async () => {
        const restrictedDir = path.join(testDir, '.restricted');
        await fs.ensureDir(restrictedDir);
        await fs.writeFile(path.join(restrictedDir, 'secret.js'), 'TODO: leak');

        await fs.writeFile(path.join(testDir, 'rigour.yml'), `
version: 1
ignore:
  - ".restricted/**"
gates:
  forbid_todos: true
  required_files: []
  context:
    enabled: false
  environment:
    enabled: false
  safety:
    protected_paths: []
  retry_loop_breaker:
    enabled: false
`);

        // Simulate EPERM by changing permissions
        await fs.chmod(restrictedDir, 0o000);

        try {
            // We need to mock process.exit or checkCommand should not exit if we want to test it easily
            // For now, we'll just verify it doesn't throw before it would exit (internal logic)
            // But checkCommand calls process.exit(1) on failure.

            // Re-importing checkCommand to ensure it uses the latest core
            const checkCommand = await getCheckCommand();
            await expect(checkCommand(testDir, [], { ci: true })).resolves.not.toThrow();
        } finally {
            await fs.chmod(restrictedDir, 0o777);
        }
    }, 30_000);

    it('should check specific files when provided', async () => {
        await fs.writeFile(path.join(testDir, 'bad.js'), 'TODO: fixme');
        await fs.writeFile(path.join(testDir, 'good.js'), 'console.log("hello")');
        await fs.writeFile(path.join(testDir, 'rigour.yml'), `
version: 1
gates:
  forbid_todos: true
  required_files: []
`);

        // If we check ONLY good.js, it should PASS (exit PASS)
        const checkCommand = await getCheckCommand();
        await checkCommand(testDir, [path.join(testDir, 'good.js')], { ci: true });
        expect(process.exit).toHaveBeenCalledWith(0);

        // If we check bad.js, it should FAIL (exit FAIL)
        vi.clearAllMocks();
        const checkCommandFail = await getCheckCommand();
        await checkCommandFail(testDir, [path.join(testDir, 'bad.js')], { ci: true });
        expect(process.exit).toHaveBeenCalledWith(1);
    });
});
