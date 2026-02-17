import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GateRunner } from './gates/runner.js';
import { Config, RawConfig, ConfigSchema } from './types/index.js';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('Environment Alignment Gate', () => {
    const testDir = path.join(os.tmpdir(), 'rigour-temp-test-env-' + process.pid);

    beforeEach(async () => {
        await fs.ensureDir(testDir);
    });

    afterEach(async () => {
        await fs.remove(testDir);
    });

    it('should detect tool version mismatch (Explicit)', async () => {
        const rawConfig: RawConfig = {
            version: 1,
            gates: {
                environment: {
                    enabled: true,
                    enforce_contracts: false,
                    tools: {
                        node: ">=99.0.0" // Guaranteed to fail
                    }
                }
            }
        };

        const config = ConfigSchema.parse(rawConfig);
        const runner = new GateRunner(config);
        const report = await runner.run(testDir);

        expect(report.status).toBe('FAIL');
        const envFailure = report.failures.find(f => f.id === 'environment-alignment');
        expect(envFailure).toBeDefined();
        expect(envFailure?.details).toContain('node');
        expect(envFailure?.details).toContain('version mismatch');
    });

    it('should detect missing environment variables', async () => {
        const rawConfig: RawConfig = {
            version: 1,
            gates: {
                environment: {
                    enabled: true,
                    required_env: ["RIGOUR_TEST_VAR_MISSING"]
                }
            }
        };

        const config = ConfigSchema.parse(rawConfig);
        const runner = new GateRunner(config);
        const report = await runner.run(testDir);

        expect(report.status).toBe('FAIL');
        expect(report.failures[0].details).toContain('RIGOUR_TEST_VAR_MISSING');
    });

    it('should discover contracts from pyproject.toml', async () => {
        // Create mock pyproject.toml with a version that will surely fail
        await fs.writeFile(path.join(testDir, 'pyproject.toml'), `
[tool.ruff]
ruff = ">=99.14.0"
`);

        const rawConfig: RawConfig = {
            version: 1,
            gates: {
                environment: {
                    enabled: true,
                    enforce_contracts: true,
                    tools: {} // Should discover ruff from file
                }
            }
        };

        const config = ConfigSchema.parse(rawConfig);
        const runner = new GateRunner(config);
        const report = await runner.run(testDir);

        // This might pass or fail depending on the local ruff version, 
        // but we want to check if the gate attempted to check ruff.
        // If ruff is missing, it will fail with "is missing".
        const ruffFailure = report.failures.find(f => f.details.includes('ruff'));
        expect(ruffFailure).toBeDefined();
    });

    it('should prioritize environment gate and run it first', async () => {
        const rawConfig: RawConfig = {
            version: 1,
            gates: {
                max_file_lines: 1,
                environment: {
                    enabled: true,
                    required_env: ["MANDATORY_SECRET_MISSING"]
                }
            }
        };

        const config = ConfigSchema.parse(rawConfig);

        // Create a file that would fail max_file_lines
        await fs.writeFile(path.join(testDir, 'large.js'), 'line1\nline2\nline3');

        const runner = new GateRunner(config);
        const report = await runner.run(testDir);

        // In a real priority system, we might want to stop after environment failure.
        // Currently GateRunner runs all, but environment-alignment has been unshifted.
        expect(Object.keys(report.summary)[0]).toBe('environment-alignment');
    });
});
