import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const PACKAGES = path.resolve(__dirname, '../../..');
const scripts = fs.readdirSync(PACKAGES)
    .filter(name => name.startsWith('brain-') && !name.includes('win'))
    .map(name => path.join(PACKAGES, name, 'bin', 'rigour-brain'));

describe('rigour-brain placeholder', () => {
    it.runIf(process.platform !== 'win32')('prints its message without running the command it names', () => {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
        const marker = path.join(bin, 'ran');
        fs.writeFileSync(path.join(bin, 'rigour'), `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });
        try {
            expect(scripts.length).toBeGreaterThan(0);
            for (const script of scripts) {
                const result = spawnSync('sh', [script, '--version'], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
                expect(result.status).toBe(1);
                expect(result.stderr).toContain('rigour deep pull');
                expect(fs.existsSync(marker)).toBe(false);
            }
        } finally {
            fs.rmSync(bin, { recursive: true, force: true });
        }
    });
});
