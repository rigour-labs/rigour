import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { detectInstallKind, doctorCommand, hasVersionShadowing } from './doctor.js';

describe('doctor helpers', () => {
    it('classifies Homebrew paths', () => {
        expect(detectInstallKind('/opt/homebrew/bin/rigour')).toBe('homebrew');
        expect(detectInstallKind('/usr/local/bin/rigour')).toBe('homebrew');
        expect(detectInstallKind('/opt/homebrew/Cellar/rigour/4.0.5/bin/rigour')).toBe('homebrew');
    });

    it('classifies npm/global node_modules paths', () => {
        expect(detectInstallKind('/opt/homebrew/lib/node_modules/@rigour-labs/cli/dist/cli.js')).toBe('npm');
        expect(detectInstallKind('/Users/test/.nvm/versions/node/v22.0.0/lib/node_modules/@rigour-labs/cli/dist/cli.js')).toBe('npm');
    });

    it('returns unknown for unrelated paths', () => {
        expect(detectInstallKind('/usr/bin/rigour')).toBe('unknown');
    });

    it('detects version shadowing only when versions differ', () => {
        expect(hasVersionShadowing(['4.0.5', '4.0.5'])).toBe(false);
        expect(hasVersionShadowing(['4.0.5', '2.0.0'])).toBe(true);
    });
});

describe('rigour doctor and a RIGOUR_HOME ending in .rigour', () => {
    it('names the state an earlier version wrote one level deeper, and how to move it', async () => {
        const set = process.env.RIGOUR_HOME;
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-home-'));
        try {
            process.env.RIGOUR_HOME = path.join(home, '.rigour');
            fs.mkdirSync(path.join(home, '.rigour', '.rigour'), { recursive: true });
            fs.writeFileSync(path.join(home, '.rigour', '.rigour', 'telemetry.json'), '{}');
            // A rigour on PATH that only prints a version, so doctor runs to its end.
            const bin = path.join(home, 'bin');
            fs.mkdirSync(bin);
            fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'rigour.cmd' : 'rigour'), process.platform === 'win32' ? '@echo 6.11.0\r\n' : '#!/bin/sh\necho 6.11.0\n', { mode: 0o755 });
            vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
            const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            await doctorCommand({}, home);
            const printed = out.mock.calls.flat().join('\n');
            expect(printed).toContain(`Rigour home: ${path.join(home, '.rigour', '.rigour')}`);
            expect(printed).toContain('written by an earlier version');
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllEnvs();
            if (set === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = set;
            fs.rmSync(home, { recursive: true, force: true });
        }
    }, 60_000);
});
