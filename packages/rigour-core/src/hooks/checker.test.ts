/**
 * Tests for the hooks fast-checker module.
 * Verifies all 4 fast gates: file-size, hallucinated-imports, promise-safety, security-patterns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runHookChecker } from './checker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import yaml from 'yaml';

describe('runHookChecker', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-checker-test-'));
        // Write minimal rigour.yml
        fs.writeFileSync(path.join(testDir, 'rigour.yml'), yaml.stringify({
            version: 1,
            gates: { max_file_lines: 50 },
        }));
        // Write package.json for import resolution
        fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({
            name: 'test-proj',
            dependencies: { express: '^4.0.0' },
        }));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should return pass for clean files', async () => {
        const filePath = path.join(testDir, 'clean.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('pass');
        expect(result.failures).toHaveLength(0);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('should detect file size violations', async () => {
        const filePath = path.join(testDir, 'big.ts');
        const lines = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`);
        fs.writeFileSync(filePath, lines.join('\n'));

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'file-size')).toBe(true);
    });

    it('should detect hardcoded secrets', async () => {
        const filePath = path.join(testDir, 'auth.ts');
        fs.writeFileSync(filePath, `
            const api_key = "abcdefghijklmnopqrstuvwxyz123456";
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'security-patterns')).toBe(true);
    });

    it('should detect command injection patterns', async () => {
        const filePath = path.join(testDir, 'cmd.ts');
        fs.writeFileSync(filePath, `
            import { exec } from 'child_process';
            exec(\`rm -rf \${userInput}\`);
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f =>
            f.gate === 'security-patterns' && f.message.includes('command injection')
        )).toBe(true);
    });

    it('should detect JSON.parse without try/catch', async () => {
        const filePath = path.join(testDir, 'parse.ts');
        fs.writeFileSync(filePath, `
            const data = JSON.parse(input);
            console.log(data);
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'promise-safety')).toBe(true);
    });

    it('should skip non-existent files gracefully', async () => {
        const result = await runHookChecker({
            cwd: testDir,
            files: ['/does/not/exist.ts'],
        });
        expect(result.status).toBe('pass');
        expect(result.failures).toHaveLength(0);
    });

    it('should handle multiple files', async () => {
        const cleanFile = path.join(testDir, 'clean.ts');
        fs.writeFileSync(cleanFile, 'export const x = 1;\n');

        const badFile = path.join(testDir, 'bad.ts');
        fs.writeFileSync(badFile, `const password = "supersecretpassword123456";`);

        const result = await runHookChecker({
            cwd: testDir,
            files: [cleanFile, badFile],
        });
        expect(result.status).toBe('fail');
        expect(result.failures.length).toBeGreaterThan(0);
    });

    it('should handle missing config gracefully', async () => {
        // Remove rigour.yml
        fs.unlinkSync(path.join(testDir, 'rigour.yml'));

        const filePath = path.join(testDir, 'test.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('pass');
    });

    it('should complete within timeout', async () => {
        const filePath = path.join(testDir, 'test.ts');
        fs.writeFileSync(filePath, 'export const x = 1;\n');

        const result = await runHookChecker({
            cwd: testDir,
            files: [filePath],
            timeout_ms: 5000,
        });
        expect(result.duration_ms).toBeLessThan(5000);
    });

    it('should detect hallucinated relative imports', async () => {
        const filePath = path.join(testDir, 'app.ts');
        fs.writeFileSync(filePath, `
            import { helper } from './nonexistent-module';
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        expect(result.status).toBe('fail');
        expect(result.failures.some(f => f.gate === 'hallucinated-imports')).toBe(true);
    });

    it('should not flag existing relative imports', async () => {
        const helperPath = path.join(testDir, 'helper.ts');
        fs.writeFileSync(helperPath, 'export const help = true;\n');

        const filePath = path.join(testDir, 'app.ts');
        fs.writeFileSync(filePath, `
            import { help } from './helper';
        `);

        const result = await runHookChecker({ cwd: testDir, files: [filePath] });
        const importFailures = result.failures.filter(f => f.gate === 'hallucinated-imports');
        expect(importFailures).toHaveLength(0);
    });
});
