import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StyleDriftGate } from './style-drift.js';

describe('StyleDriftGate', () => {
    let cwd: string;

    beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-drift-')); });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('does not compare default imports against unrelated named imports', async () => {
        const src = path.join(cwd, 'src');
        fs.mkdirSync(src);
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(src, `named${i}.ts`), `import { value } from './shared';\nexport function helper${i}() { return value; }\n`);
        }
        fs.writeFileSync(path.join(src, 'mui.ts'), [
            "import Box from '@mui/material/Box';",
            "import TextField from '@mui/material/TextField';",
            "import Button from '@mui/material/Button';",
        ].join('\n'));
        const gate = new StyleDriftGate();
        expect(await gate.run({ cwd })).toEqual([]);
        const findings = await gate.run({ cwd });
        expect(findings.some(finding => finding.details.includes('import style'))).toBe(false);
    });
});
