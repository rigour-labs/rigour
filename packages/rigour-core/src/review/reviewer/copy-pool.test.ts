import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from './exec.js';
import { gitIn, makeRepo } from './__tests__/judge-fakes.js';
import { copyPool } from './copy-pool.js';
import { ON_POSIX, POSIX_ONLY } from './__tests__/run-code-harness.js';

describe.runIf(ON_POSIX)(`one review's copies ${POSIX_ONLY}`, () => {
    let repo: string;
    beforeEach(() => {
        repo = makeRepo();
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('are at most two, however many passes, each reset to the head before it is used again, and all removed at the end', async () => {
        const pool = copyPool(repo, gitIn(repo, 'rev-parse', 'HEAD').trim(), defaultExec);
        let running = 0;
        let most = 0;
        const seen: Array<{ dir: string; before: string[]; tmp: string[] }> = [];
        const tmps = new Set<string>();
        const pass = (i: number) => pool.run(async (dir, _started, tmp) => {
            most = Math.max(most, ++running);
            const judgeTmp = path.join(tmp, `claude-${process.getuid!()}`); // the TMPDIR its commands get
            seen.push({ dir, before: fs.readdirSync(dir).sort(), tmp: fs.readdirSync(judgeTmp) });
            fs.mkdirSync(path.join(judgeTmp, 'pytest-of-dev-a'));
            tmps.add(tmp);
            fs.writeFileSync(path.join(dir, `scratch-${i}.mjs`), '');
            fs.writeFileSync(path.join(dir, 'a.ts'), 'rewritten\n');
            await new Promise(resolve => setTimeout(resolve, 200));
            running--;
            return i;
        });
        expect(await Promise.all([0, 1, 2, 3, 4].map(pass))).toEqual([0, 1, 2, 3, 4]);
        expect(most).toBe(2);
        const dirs = [...new Set(seen.map(s => s.dir))];
        expect(dirs).toHaveLength(2);
        for (const s of seen) expect(s.before).toEqual(['.git', 'a.ts', 'src']); // no earlier pass's scratch file
        for (const s of seen) expect(s.tmp).toEqual([]); // nor its temporary files
        for (const dir of dirs) expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('rewritten\n');
        pool.close();
        for (const dir of dirs) expect([fs.existsSync(dir), fs.existsSync(path.dirname(dir))]).toEqual([false, false]);
        expect([...tmps].filter(tmp => fs.existsSync(tmp))).toEqual([]); // the judges' temporary bases with them
    });

    it('give the next pass the checkout\'s node_modules again, whatever a judge put in its place', async () => {
        fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = "real";\n');
        const pool = copyPool(repo, gitIn(repo, 'rev-parse', 'HEAD').trim(), defaultExec, () => undefined, 1);
        const seen: string[] = [];
        const poison = [
            (link: string) => { fs.rmSync(link); fs.mkdirSync(path.join(link, 'dep'), { recursive: true }); fs.writeFileSync(path.join(link, 'dep', 'index.js'), 'module.exports = "poisoned";\n'); },
            (link: string) => { fs.rmSync(link); fs.symlinkSync(fs.mkdtempSync(path.join(path.dirname(path.dirname(link)), 'elsewhere-')), link); },
            () => undefined,
        ];
        for (const act of poison) {
            await pool.run(async dir => {
                const link = path.join(dir, 'node_modules');
                seen.push(`${fs.lstatSync(link).isSymbolicLink() ? 'link' : 'folder'} to ${fs.realpathSync(link) === fs.realpathSync(path.join(repo, 'node_modules')) ? 'the checkout' : 'elsewhere'}`);
                act(link);
            });
        }
        pool.close();
        expect(seen).toEqual(['link to the checkout', 'link to the checkout', 'link to the checkout']);
        expect(fs.readFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = "real";\n');
    });
});
