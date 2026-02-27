import { describe, expect, it } from 'vitest';
import { detectInstallKind, hasVersionShadowing } from './doctor.js';

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
