import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CoverageGate } from './coverage.js';

describe('CoverageGate', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gate-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('flags low coverage from lcov report', async () => {
        fs.mkdirSync(path.join(testDir, 'coverage'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'coverage', 'lcov.info'),
            [
                'TN:',
                'SF:src/alpha.ts',
                'LF:10',
                'LH:3',
                'end_of_record',
            ].join('\n'),
            'utf-8'
        );

        const gate = new CoverageGate({} as any);
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(1);
        expect(failures[0].id).toBe('DYNAMIC_COVERAGE_LOW');
        expect(failures[0].files).toEqual(['src/alpha.ts']);
    });

    it('parses coverage-final.json reports', async () => {
        fs.writeFileSync(
            path.join(testDir, 'coverage-final.json'),
            JSON.stringify({
                'src/beta.ts': {
                    s: { '1': 1, '2': 0, '3': 0, '4': 1 },
                },
            }),
            'utf-8'
        );

        const gate = new CoverageGate({} as any);
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('ignores coverage reports under node_modules', async () => {
        fs.mkdirSync(path.join(testDir, 'node_modules', 'pkg', 'coverage'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'node_modules', 'pkg', 'coverage', 'lcov.info'),
            ['TN:', 'SF:src/dep.ts', 'LF:10', 'LH:0', 'end_of_record'].join('\n'),
            'utf-8'
        );

        const gate = new CoverageGate({} as any);
        const failures = await gate.run({ cwd: testDir });

        expect(failures).toHaveLength(0);
    });

    it('respects context.ignore for coverage report discovery', async () => {
        fs.mkdirSync(path.join(testDir, 'generated', 'reports'), { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'generated', 'reports', 'lcov.info'),
            ['TN:', 'SF:src/generated.ts', 'LF:10', 'LH:0', 'end_of_record'].join('\n'),
            'utf-8'
        );

        const gate = new CoverageGate({} as any);
        const failures = await gate.run({ cwd: testDir, ignore: ['generated/**'] });

        expect(failures).toHaveLength(0);
    });
});
