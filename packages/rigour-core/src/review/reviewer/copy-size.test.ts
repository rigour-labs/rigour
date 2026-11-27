import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitIn, makeRepo } from './__tests__/judge-fakes.js';
import { copyCaveats, copySizeRefusal } from './copy-size.js';
import { reviewIn, runCodeHarness } from './__tests__/run-code-harness.js';

const MB = 1024 * 1024;

describe('whether the judges\' copies fit', () => {
    let repo: string;
    beforeEach(() => {
        repo = makeRepo({}, { 'big.bin': 'x'.repeat(3 * MB) });
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));
    const head = () => gitIn(repo, 'rev-parse', 'HEAD').trim();

    it('measures the reviewed commit\'s files, and refuses a copy over the setting or with too little disk free', () => {
        expect(copySizeRefusal(repo, head(), 2048, 2, undefined, 100 * MB)).toBeUndefined();
        expect(copySizeRefusal(repo, head(), 2, 1, undefined, 100 * MB)).toBe(`run_code refused: a copy of ${head().slice(0, 9)} takes 4 MB, over review.reviewer.run_code_max_mb (2); every judge stays read-only`);
        expect(copySizeRefusal(repo, head(), 2048, 2, undefined, 10 * MB)).toMatch(/^run_code refused: 10 MB free in .+, under twice the 8 MB the judges' copies take; every judge stays read-only$/);
    });

    it('says what a copy leaves out: submodules, and Git LFS files as pointers', () => {
        expect(copyCaveats(repo, head())).toEqual([]);
        fs.writeFileSync(path.join(repo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n');
        gitIn(repo, 'add', '-A');
        gitIn(repo, 'update-index', '--add', '--cacheinfo', `160000,${head()},vendor/lib`);
        gitIn(repo, 'commit', '-qm', 'lfs and a submodule');
        expect(copyCaveats(repo, head())).toEqual(["run_code: submodules are not checked out in the judge's copy", "run_code: Git LFS files are pointers, not their content, in the judge's copy"]);
    });
});

describe('a review whose copy would not fit', () => {
    const h = runCodeHarness();
    it('runs every judge read-only and says why, the cap read from the base', async () => {
        const repo = makeRepo({ 'rigour.yml': 'version: 1\nreview:\n  reviewer:\n    run_code: "on"\n    run_code_max_mb: 1\n' }, { 'big.bin': 'x'.repeat(3 * MB) });
        h.made.push(repo);
        const result = await reviewIn(repo, { run_code_max_mb: 4096 }); // the branch's own cap is not the one that counts
        expect(h.judges.runs().at(-1)!.argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
        expect(result.mode?.caveats).toEqual([expect.stringMatching(/^run_code refused: a copy of \w{9} takes 4 MB, over review\.reviewer\.run_code_max_mb \(1\); every judge stays read-only$/)]);
    });
});
