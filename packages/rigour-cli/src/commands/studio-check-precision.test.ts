import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStudioCheckPrecision } from './studio-check-precision.js';

describe('loadStudioCheckPrecision', () => {
    let cwd: string | undefined;
    afterEach(() => { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); cwd = undefined; });

    it('lists each check with its posterior, most dismissed first, and the mute rule', () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-precision-'));
        fs.mkdirSync(path.join(cwd, '.rigour'));
        fs.writeFileSync(path.join(cwd, '.rigour', 'check-outcomes.json'), JSON.stringify({
            'semantic-bugs: Unbounded read': { fixed: 4, dismissed: 0 },
            'ast: Too many parameters': { fixed: 0, dismissed: 6 },
        }));
        const view = loadStudioCheckPrecision(cwd);
        expect(view.checks.map(c => [c.check, Math.round(c.precision * 100), c.muted])).toEqual([
            ['ast: Too many parameters', 13, true],
            ['semantic-bugs: Unbounded read', 83, false],
        ]);
        expect(view).toMatchObject({ muteBelow: 0.25, muteMinOutcomes: 5 });
    });
});
