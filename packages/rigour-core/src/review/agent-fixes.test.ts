import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { listOpenFindings, listResolvedFixes, openFindingCount, recheckOpenFindings, recordReviewOutcome } from './agent-fixes.js';
import { readOutcomes } from './check-outcomes.js';
import { readStories } from './stories.js';

const finding = (file: string): Failure => ({ id: 'semantic-bugs', title: 't', details: 'd', files: [file], line: 2 } as Failure);

describe('recordReviewOutcome', () => {
    let cwd: string;
    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fixes-'));
        fs.writeFileSync(path.join(cwd, 'a.ts'), 'before\n');
    });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('stores the before and after once a reviewed file no longer has the finding', () => {
        expect(recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts'])).toMatchObject({ opened: 1, resolved: 0 });
        fs.writeFileSync(path.join(cwd, 'a.ts'), 'after\n');
        expect(recordReviewOutcome(cwd, [], ['a.ts'])).toMatchObject({ opened: 0, resolved: 1 });
        const [fix] = listResolvedFixes(cwd);
        expect(fix).toMatchObject({ file: 'a.ts', rule: 'semantic-bugs', before: 'before\n', after: 'after\n' });
        expect(openFindingCount(cwd)).toBe(0);
    });

    it('keeps a finding open when its file was not part of the review (committed, not fixed)', () => {
        recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts']);
        expect(recordReviewOutcome(cwd, [], ['other.ts'])).toMatchObject({ opened: 0, resolved: 0 });
        expect(openFindingCount(cwd)).toBe(1);
    });

    it('does not count a finding that vanished without an edit as a fix', () => {
        recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts']);
        expect(recordReviewOutcome(cwd, [], ['a.ts'])).toMatchObject({ opened: 0, resolved: 0 });
        expect(listResolvedFixes(cwd)).toEqual([]);
    });

    /** Marks every open finding as opened by an older version of the checks. */
    const fromOlderChecks = () => {
        const file = path.join(cwd, '.rigour', 'agent-fixes', 'open.json');
        const open = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of Object.values(open) as Array<{ checker?: string }>) entry.checker = '6.9.0';
        fs.writeFileSync(file, JSON.stringify(open));
    };

    it('closes a finding an older version of the checks opened as checker-changed: never a fix, a story or an outcome', () => {
        recordReviewOutcome(cwd, [{ ...finding('a.ts'), id: 'hallucinated-imports' }], ['a.ts'], 'edit');
        fromOlderChecks();
        fs.writeFileSync(path.join(cwd, 'a.ts'), 'edited by the agent\n'); // the file changed, as it does when an agent edits it
        expect(recordReviewOutcome(cwd, [], ['a.ts'], 'edit')).toMatchObject({ resolved: 0, checkerChanged: 1 });
        expect(listResolvedFixes(cwd)).toEqual([]);
        expect(readStories(cwd)).toEqual([]);
        expect(readOutcomes(cwd)['hallucinated-imports']?.fixed ?? 0).toBe(0);
        expect(openFindingCount(cwd)).toBe(0);
    });

    it('re-checks what older checks opened: a false finding closes, a true one stays open as the new checks\' own', async () => {
        fs.writeFileSync(path.join(cwd, 'b.ts'), 'still wrong\n');
        recordReviewOutcome(cwd, [{ ...finding('a.ts'), id: 'hallucinated-imports' }, finding('b.ts')], ['a.ts', 'b.ts'], 'edit');
        fromOlderChecks();
        const checked: string[][] = [];
        const result = await recheckOpenFindings(cwd, 'edit', async files => { checked.push(files); return [finding('b.ts')]; });
        expect(result).toEqual({ closed: 1, kept: 1 });
        expect(checked).toEqual([['a.ts', 'b.ts']]);
        expect(listOpenFindings(cwd).map(f => f.file)).toEqual(['b.ts']);
        expect(listResolvedFixes(cwd)).toEqual([]);
        expect(await recheckOpenFindings(cwd, 'edit', async () => { throw new Error('nothing old is left to check'); })).toEqual({ closed: 0, kept: 0 });
    });
});
