import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultExec } from './exec.js';
import { gitIn, makeRepo } from './__tests__/judge-fakes.js';
import { copyPool } from './copy-pool.js';

describe("one review's copies", () => {
    let repo: string;
    beforeEach(() => {
        repo = makeRepo();
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    it('are at most two, however many passes, each reset to the head before it is used again, and all removed at the end', async () => {
        const pool = copyPool(repo, gitIn(repo, 'rev-parse', 'HEAD').trim(), defaultExec);
        let running = 0;
        let most = 0;
        const seen: Array<{ dir: string; before: string[] }> = [];
        const pass = (i: number) => pool.run(async dir => {
            most = Math.max(most, ++running);
            seen.push({ dir, before: fs.readdirSync(dir).sort() });
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
        for (const dir of dirs) expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('rewritten\n');
        pool.close();
        for (const dir of dirs) expect([fs.existsSync(dir), fs.existsSync(path.dirname(dir))]).toEqual([false, false]);
    });
});
