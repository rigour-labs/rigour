import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GateRunner } from '../src/gates/runner.js';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_CWD = path.join(__dirname, '../temp-test-context');

describe('Context Awareness Engine', () => {
    beforeAll(async () => {
        await fs.ensureDir(TEST_CWD);
    });

    afterAll(async () => {
        await fs.remove(TEST_CWD);
    });

    it('should detect context drift for redundant env suffixes (Golden Example)', async () => {
        // Setup: Define standard GCP_PROJECT_ID
        await fs.writeFile(path.join(TEST_CWD, '.env.example'), 'GCP_PROJECT_ID=my-project\n');

        // Setup: Use drifted GCP_PROJECT_ID_PRODUCTION
        await fs.writeFile(path.join(TEST_CWD, 'feature.js'), `
            const id = process.env.GCP_PROJECT_ID_PRODUCTION;
            console.log(id);
        `);

        const config = {
            version: 1,
            commands: {},
            gates: {
                context: {
                    enabled: true,
                    sensitivity: 0.8,
                    mining_depth: 10,
                    ignored_patterns: [],
                    cross_file_patterns: true,
                    naming_consistency: true,
                    import_relationships: true,
                    max_cross_file_depth: 50,
                },
            },
            output: { report_path: 'rigour-report.json' }
        };

        const runner = new GateRunner(config as any);
        const report = await runner.run(TEST_CWD);

        const driftFailures = report.failures.filter(f => f.id === 'context-drift');
        expect(driftFailures.length).toBeGreaterThan(0);
        expect(driftFailures[0].details).toContain('GCP_PROJECT_ID_PRODUCTION');
        expect(driftFailures[0].hint).toContain('GCP_PROJECT_ID');
    });

    it('should not flag valid environment variables', async () => {
        await fs.writeFile(path.join(TEST_CWD, 'valid.js'), `
            const id = process.env.GCP_PROJECT_ID;
        `);

        const config = {
            version: 1,
            commands: {},
            gates: {
                context: {
                    enabled: true,
                    sensitivity: 0.8,
                    mining_depth: 100,
                    ignored_patterns: [],
                    cross_file_patterns: true,
                    naming_consistency: true,
                    import_relationships: true,
                    max_cross_file_depth: 50,
                },
            },
            output: { report_path: 'rigour-report.json' }
        };

        const runner = new GateRunner(config as any);
        const report = await runner.run(TEST_CWD);

        const driftFailures = report.failures.filter(f => f.id === 'context-drift');
        // Filter out failures from other files if they still exist in TEST_CWD
        const specificFailures = driftFailures.filter(f => f.files?.includes('valid.js'));
        expect(specificFailures.length).toBe(0);
    });
});
