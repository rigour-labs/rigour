import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { listResolvedFixes, openFindingCount, recordReviewOutcome } from './agent-fixes.js';

const finding = (file: string): Failure => ({ id: 'semantic-bugs', title: 't', details: 'd', files: [file], line: 2 } as Failure);

describe('recordReviewOutcome', () => {
    let cwd: string;
    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fixes-'));
        fs.writeFileSync(path.join(cwd, 'a.ts'), 'before\n');
    });
    afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

    it('stores the before and after once a reviewed file no longer has the finding', () => {
        expect(recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts'])).toEqual({ opened: 1, resolved: 0 });
        fs.writeFileSync(path.join(cwd, 'a.ts'), 'after\n');
        expect(recordReviewOutcome(cwd, [], ['a.ts'])).toEqual({ opened: 0, resolved: 1 });
        const [fix] = listResolvedFixes(cwd);
        expect(fix).toMatchObject({ file: 'a.ts', rule: 'semantic-bugs', before: 'before\n', after: 'after\n' });
        expect(openFindingCount(cwd)).toBe(0);
    });

    it('keeps a finding open when its file was not part of the review (committed, not fixed)', () => {
        recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts']);
        expect(recordReviewOutcome(cwd, [], ['other.ts'])).toEqual({ opened: 0, resolved: 0 });
        expect(openFindingCount(cwd)).toBe(1);
    });

    it('does not count a finding that vanished without an edit as a fix', () => {
        recordReviewOutcome(cwd, [finding('a.ts')], ['a.ts']);
        expect(recordReviewOutcome(cwd, [], ['a.ts'])).toEqual({ opened: 0, resolved: 0 });
        expect(listResolvedFixes(cwd)).toEqual([]);
    });
});
