import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkCommand } from './commands/check.js';
import fs from 'fs-extra';
import path from 'path';

describe('CLI Smoke Test', () => {
    const testDir = path.join(process.cwd(), 'temp-smoke-test');

    beforeEach(async () => {
        await fs.ensureDir(testDir);
        // @ts-ignore
        vi.spyOn(process, 'exit').mockImplementation(() => { });
    });

    afterEach(async () => {
        await fs.remove(testDir);
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
`);

        // Simulate EPERM by changing permissions
        await fs.chmod(restrictedDir, 0o000);

        try {
            // We need to mock process.exit or checkCommand should not exit if we want to test it easily
            // For now, we'll just verify it doesn't throw before it would exit (internal logic)
            // But checkCommand calls process.exit(1) on failure.

            // Re-importing checkCommand to ensure it uses the latest core
            await expect(checkCommand(testDir, [], { ci: true })).resolves.not.toThrow();
        } finally {
            await fs.chmod(restrictedDir, 0o777);
        }
    });

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
        await checkCommand(testDir, [path.join(testDir, 'good.js')], { ci: true });
        expect(process.exit).toHaveBeenCalledWith(0);

        // If we check bad.js, it should FAIL (exit FAIL)
        vi.clearAllMocks();
        await checkCommand(testDir, [path.join(testDir, 'bad.js')], { ci: true });
        expect(process.exit).toHaveBeenCalledWith(1);
    });
});
