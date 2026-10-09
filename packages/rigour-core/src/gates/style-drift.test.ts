import { execFileSync } from 'child_process';
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

describe('StyleDriftGate in a git checkout', () => {
    let cwd: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    const snake = (n: number) => `def load_rows_${n}(file_path):\n    row_list = []\n    return row_list\n\ndef parse_line_${n}(line_text):\n    return line_text.split(',')\n\ndef count_rows_${n}(row_list):\n    return len(row_list)\n\ndata_path_${n} = 'data.csv'\nmax_rows_${n} = 100\nrow_limit_${n} = 50\n`;
    const camel = (n: number) => `def loadRows${n}(filePath):\n    rowList = []\n    return rowList\n\ndef parseLine${n}(lineText):\n    return lineText.split(',')\n\ndef countRows${n}(rowList):\n    return len(rowList)\n\ndataPath${n} = 'data.csv'\nmaxRows${n} = 100\nrowLimit${n} = 50\n`;
    const write = (file: string, text: string) => fs.writeFileSync(path.join(cwd, file), text);
    const flagged = async () => [...new Set((await new StyleDriftGate().run({ cwd })).map(f => f.files?.[0]))].sort(); // a file can drift on functions and variables both

    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-drift-git-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('.gitignore', '.rigour/\n');
        for (let i = 0; i < 6; i++) write(`svc_${i}.py`, snake(i));
        write('legacy.py', camel(0)); // committed and untouched: the project's own code is never drift
        git('add', '-A');
        git('commit', '-qm', 'base');
        git('checkout', '-qb', 'feature');
    });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('gives a clean tree the same verdict after any number of runs on a dirty one, and writes nothing', async () => {
        write('svc_0.py', snake(0) + 'extra_rows = []\n'); // one changed file, so there is something to compare
        const fresh = await flagged();
        for (let i = 0; i < 9; i++) write(`drift_${i}.py`, camel(i + 1));
        for (let run = 0; run < 3; run++) expect(await flagged()).toEqual(Array.from({ length: 9 }, (_, i) => `drift_${i}.py`));
        for (let i = 0; i < 9; i++) fs.rmSync(path.join(cwd, `drift_${i}.py`));
        expect(await flagged()).toEqual(fresh);
        expect(fresh).toEqual([]);
        expect(fs.existsSync(path.join(cwd, '.rigour', 'style-baseline.json'))).toBe(false);
    });

    it('compares only the files that differ from the base: a new one, never the committed code', async () => {
        write('reports.py', camel(7));
        git('add', '-A');
        git('commit', '-qm', 'reports');
        expect(await flagged()).toEqual(['reports.py']);
    });

    it('ignores a stale .rigour/style-baseline.json left by an older version', async () => {
        const stale = { version: 3, createdAt: '', languages: { python: { naming: { functions: { camelCase: 90, snake_case: 1, PascalCase: 0, SCREAMING_SNAKE: 0, 'kebab-case': 0, other: 0 }, variables: { camelCase: 90, snake_case: 1, PascalCase: 0, SCREAMING_SNAKE: 0, 'kebab-case': 0, other: 0 } }, errorHandling: { tryCatch: 0, promiseCatch: 0, resultType: 0 }, importStyle: { named: 0, default: 0, wildcard: 0, sideEffect: 0 }, quoteStyle: { single: 0, double: 0, backtick: 0 }, totalFilesAnalyzed: 30, createdAt: '' } } };
        fs.mkdirSync(path.join(cwd, '.rigour'));
        fs.writeFileSync(path.join(cwd, '.rigour', 'style-baseline.json'), JSON.stringify(stale));
        write('svc_1.py', snake(1) + 'extra_rows = []\n');
        expect(await flagged()).toEqual([]);
    });

    it('never reads a snake_case project whose names are mostly one word as camelCase', async () => {
        // run, main, load, data, rows, size are camelCase and snake_case alike; only parse_line_N says which this project uses.
        for (let i = 0; i < 6; i++) write(`svc_${i}.py`, `def run():\n    pass\n\ndef main():\n    pass\n\ndef load():\n    pass\n\ndef parse_line_${i}(text):\n    return text\n\ndata = 1\nrows = []\nsize = 3\nrow_limit_${i} = 5\n`);
        fs.rmSync(path.join(cwd, 'legacy.py'));
        git('add', '-A');
        git('commit', '-qm', 'one-word names');
        git('checkout', '-qb', 'reports');
        write('reports.py', snake(9));
        expect(await new StyleDriftGate().run({ cwd })).toEqual([]);
    });

    it('compares variables with variables: module constants in SCREAMING_SNAKE are not the project\'s variable casing', async () => {
        for (let i = 0; i < 6; i++) write(`settings_${i}.py`, `MAX_ROWS_${i} = 100\nDATA_PATH_${i} = 'data.csv'\nRETRY_LIMIT_${i} = 3\nTIMEOUT_SECONDS_${i} = 30\nrow_count_${i} = 0\n\ndef load_rows_${i}(file_path):\n    return []\n`);
        fs.rmSync(path.join(cwd, 'legacy.py'));
        git('add', '-A');
        git('commit', '-qm', 'settings');
        git('checkout', '-qb', 'notebook');
        write('notebook.py', `row_limit = 5\nfile_name = 'a.csv'\nbatch_size = 10\n\ndef read_rows(file_path):\n    return []\n`);
        expect(await new StyleDriftGate().run({ cwd })).toEqual([]);
    });

    it('on the base branch itself, compares only uncommitted changes: a clean tree has nothing to compare', async () => {
        git('checkout', '-q', 'main');
        expect(await flagged()).toEqual([]);
        write('scratch.py', camel(3));
        expect(await flagged()).toEqual(['scratch.py']);
    });
});
