import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { scanCommand } from './scan.js';

describe('scanCommand', () => {
    let testDir: string;

    beforeEach(async () => {
        testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rigour-scan-test-'));
        vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(async () => {
        await fs.remove(testDir);
        vi.restoreAllMocks();
    });

    it('runs in zero-config mode without rigour.yml', async () => {
        await fs.writeJson(path.join(testDir, 'package.json'), { name: 'scan-zero-config-test' });
        await fs.writeFile(path.join(testDir, 'index.js'), "import fake from 'totally-fake-package';\nconsole.log(fake);\n");

        await expect(scanCommand(testDir, [], {})).resolves.not.toThrow();

        expect(process.exit).toHaveBeenCalled();
        expect(await fs.pathExists(path.join(testDir, 'rigour-report.json'))).toBe(true);
    }, 30_000);

    it('uses provided config path when passed', async () => {
        await fs.writeFile(path.join(testDir, 'app.js'), "export const ok = 42;\n");
        await fs.writeFile(path.join(testDir, 'scan-config.yml'), `
version: 1
gates:
  required_files: []
  forbid_todos: false
  forbid_fixme: false
  context:
    enabled: false
  environment:
    enabled: false
  retry_loop_breaker:
    enabled: false
  security:
    enabled: false
  duplication_drift:
    enabled: false
  hallucinated_imports:
    enabled: false
  inconsistent_error_handling:
    enabled: false
  context_window_artifacts:
    enabled: false
  promise_safety:
    enabled: false
  phantom_apis:
    enabled: false
  deprecated_apis:
    enabled: false
  test_quality:
    enabled: false
output:
  report_path: scan-report.json
`);

        await expect(scanCommand(testDir, [], { config: 'scan-config.yml' })).resolves.not.toThrow();

        expect(process.exit).toHaveBeenCalledWith(0);
        expect(await fs.pathExists(path.join(testDir, 'scan-report.json'))).toBe(true);
    }, 30_000);
});
