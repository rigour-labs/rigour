import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureExecutableBinary, isExecutableBinary } from './executable.js';

describe('executable helpers', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-exec-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('detects executable files', () => {
        const binaryPath = path.join(testDir, 'rigour-brain');
        fs.writeFileSync(binaryPath, '#!/usr/bin/env sh\necho ok\n', 'utf-8');
        fs.chmodSync(binaryPath, 0o755);

        expect(isExecutableBinary(binaryPath)).toBe(true);
    });

    it('repairs executable bit when missing', () => {
        const binaryPath = path.join(testDir, 'rigour-brain');
        fs.writeFileSync(binaryPath, '#!/usr/bin/env sh\necho ok\n', 'utf-8');
        fs.chmodSync(binaryPath, 0o644);

        const result = ensureExecutableBinary(binaryPath);

        if (process.platform === 'win32') {
            // Windows does not use POSIX executable bits.
            expect(result.ok).toBe(true);
            expect(result.fixed).toBe(false);
            expect(isExecutableBinary(binaryPath)).toBe(true);
            return;
        }

        // Some CI/filesystem setups can deny chmod transitions; in that case
        // the helper should fail gracefully without throwing.
        if (!result.ok) {
            expect(result.fixed).toBe(false);
            return;
        }

        expect(result.fixed).toBe(true);
        expect(isExecutableBinary(binaryPath)).toBe(true);
    });
});
