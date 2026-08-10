import { describe, expect, it } from 'vitest';
import { getPinnedCheckerCommand } from './cli-command.js';

describe('getPinnedCheckerCommand', () => {
    it('pins generated hooks to the installed sibling CLI version', () => {
        expect(getPinnedCheckerCommand())
            .toMatch(/^npx --yes @rigour-labs\/cli@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? hooks check$/);
    });
});
