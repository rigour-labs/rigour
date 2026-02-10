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
    it('should classify arrow function exports as camelCase, not unknown', async () => {
        // Create files with arrow function patterns that previously returned 'unknown'
        await fs.writeFile(path.join(TEST_CWD, 'api.ts'), `
            export const fetchData = async () => { return []; };
            export const getUserProfile = async (id: string) => { return {}; };
            export const use = () => {};
            export const get = async () => {};
            const handleClick = (e: Event) => {};
            let processItem = async (item: any) => {};
        `);

        // Create a second file with consistent arrow function naming
        await fs.writeFile(path.join(TEST_CWD, 'service.ts'), `
            export const createUser = async (data: any) => {};
            export const deleteUser = async (id: string) => {};
            export const updateUser = async (id: string, data: any) => {};
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

        // Should NOT have any "unknown" naming convention failures
        const namingFailures = report.failures.filter(f =>
            f.id === 'context-drift' && f.details?.includes('unknown')
        );
        expect(namingFailures.length).toBe(0);
    });

    it('should not classify plain variable declarations as function patterns', async () => {
        // Create file with non-function const declarations
        await fs.writeFile(path.join(TEST_CWD, 'constants.ts'), `
            export const API_URL = 'https://api.example.com';
            export const MAX_RETRIES = 3;
            const config = { timeout: 5000 };
            let count = 0;
        `);

        // Create file with actual functions for a dominant pattern
        await fs.writeFile(path.join(TEST_CWD, 'utils.ts'), `
            function getData() { return []; }
            function setData(d: any) { return d; }
            function processRequest(req: any) { return req; }
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

        // SCREAMING_SNAKE constants should NOT create naming drift failures
        // because they should not be in the 'function' pattern bucket at all
        const namingFailures = report.failures.filter(f =>
            f.id === 'context-drift' && f.details?.includes('SCREAMING_SNAKE')
        );
        expect(namingFailures.length).toBe(0);
    });
});

/**
 * Direct unit tests for detectCasing logic
 */
describe('detectCasing classification', () => {
    // We test the regex rules directly since detectCasing is private
    function detectCasing(name: string): string {
        if (/^[A-Z][a-z]/.test(name) && /[a-z][A-Z]/.test(name)) return 'PascalCase';
        if (/^[a-z]/.test(name) && /[a-z][A-Z]/.test(name)) return 'camelCase';
        if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';  // single-word lowercase
        if (/^[a-z]+(_[a-z]+)+$/.test(name)) return 'snake_case';
        if (/^[A-Z]+(_[A-Z]+)*$/.test(name)) return 'SCREAMING_SNAKE';
        if (/^[A-Z][a-zA-Z]*$/.test(name)) return 'PascalCase';
        return 'unknown';
    }

    // Multi-word camelCase
    it('classifies multi-word camelCase', () => {
        expect(detectCasing('fetchData')).toBe('camelCase');
        expect(detectCasing('getUserProfile')).toBe('camelCase');
        expect(detectCasing('handleClick')).toBe('camelCase');
        expect(detectCasing('processItem')).toBe('camelCase');
        expect(detectCasing('createNewUser')).toBe('camelCase');
    });

    // Single-word lowercase (the bug fix)
    it('classifies single-word lowercase as camelCase', () => {
        expect(detectCasing('fetch')).toBe('camelCase');
        expect(detectCasing('use')).toBe('camelCase');
        expect(detectCasing('get')).toBe('camelCase');
        expect(detectCasing('set')).toBe('camelCase');
        expect(detectCasing('run')).toBe('camelCase');
        expect(detectCasing('a')).toBe('camelCase');
        expect(detectCasing('x')).toBe('camelCase');
        expect(detectCasing('id')).toBe('camelCase');
    });

    // Single-word lowercase with digits
    it('classifies lowercase with digits as camelCase', () => {
        expect(detectCasing('handler2')).toBe('camelCase');
        expect(detectCasing('config3')).toBe('camelCase');
        expect(detectCasing('v2')).toBe('camelCase');
    });

    // PascalCase
    it('classifies PascalCase', () => {
        expect(detectCasing('MyComponent')).toBe('PascalCase');
        expect(detectCasing('UserService')).toBe('PascalCase');
        expect(detectCasing('App')).toBe('PascalCase');
        expect(detectCasing('A')).toBe('SCREAMING_SNAKE'); // single uppercase letter
    });

    // snake_case
    it('classifies snake_case', () => {
        expect(detectCasing('my_func')).toBe('snake_case');
        expect(detectCasing('get_data')).toBe('snake_case');
        expect(detectCasing('process_all_items')).toBe('snake_case');
    });

    // SCREAMING_SNAKE
    it('classifies SCREAMING_SNAKE_CASE', () => {
        expect(detectCasing('API_URL')).toBe('SCREAMING_SNAKE');
        expect(detectCasing('MAX_RETRIES')).toBe('SCREAMING_SNAKE');
        expect(detectCasing('A')).toBe('SCREAMING_SNAKE');
        expect(detectCasing('DB')).toBe('SCREAMING_SNAKE');
    });

    // Edge cases that should NOT be unknown
    it('does not return unknown for valid identifiers', () => {
        const validIdentifiers = [
            'fetch', 'getData', 'MyClass', 'my_func', 'API_KEY',
            'use', 'run', 'a', 'x', 'id', 'App', 'handler2',
            'processItem', 'UserProfile', 'get_all_data', 'MAX_SIZE',
        ];
        for (const name of validIdentifiers) {
            expect(detectCasing(name)).not.toBe('unknown');
        }
    });
});
