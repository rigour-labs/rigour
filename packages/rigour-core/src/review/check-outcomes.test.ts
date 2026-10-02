import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { checkId, checkPrecisions, isMuted, precisionOf, readOutcomes, recordOutcome, rememberReported } from './check-outcomes.js';
import { dismissFinding, findingKey, quietSplit } from './quiet.js';
import { recordReviewOutcome } from './agent-fixes.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'outcomes-')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const finding = (id: string, title: string, file = 'src/a.ts', details = `${title} here`): Failure =>
    ({ id, title, details, severity: 'low', provenance: 'traditional', files: [file], line: 1 });

describe('check precision', () => {
    it('starts at an honest 0.5 and follows the evidence', () => {
        expect(precisionOf({ fixed: 0, dismissed: 0 })).toBe(0.5);
        expect(precisionOf({ fixed: 0, dismissed: 8 })).toBe(0.1);
        expect(precisionOf({ fixed: 8, dismissed: 0 })).toBe(0.9);
    });

    it('mutes only on clear evidence: enough outcomes and a low posterior', () => {
        expect(isMuted({ fixed: 0, dismissed: 3 })).toBe(false);
        expect(isMuted({ fixed: 0, dismissed: 5 })).toBe(true);
        expect(isMuted({ fixed: 2, dismissed: 4 })).toBe(false);
    });

    it('names a check by gate and rule, so one rule in a gate never mutes its neighbours', () => {
        expect(checkId(finding('ast', 'Function too complex'))).toBe('ast: Function too complex');
        expect(checkId({ rule: 'ast' })).toBe('ast');
    });
});

describe('outcomes from real decisions', () => {
    it('attributes a dismissal by key to the check review reported it from', () => {
        const f = finding('ast', 'Too many parameters');
        rememberReported(cwd, [{ key: findingKey(f), check: checkId(f) }]);
        expect(dismissFinding(cwd, findingKey(f), 'builder needs these')).toBe(true);
        expect(dismissFinding(cwd, findingKey(f), 'again')).toBe(true);
        expect(readOutcomes(cwd)).toEqual({ 'ast: Too many parameters': { fixed: 0, dismissed: 1 } });
    });

    it('counts a fix an agent made against the check that reported it', () => {
        fs.mkdirSync(path.join(cwd, 'src'));
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'before\n');
        recordReviewOutcome(cwd, [finding('semantic-bugs', 'Unbounded read')], ['src/a.ts']);
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'after\n');
        recordReviewOutcome(cwd, [], ['src/a.ts']);
        expect(checkPrecisions(cwd)).toEqual([expect.objectContaining({ check: 'semantic-bugs: Unbounded read', fixed: 1, dismissed: 0 })]);
    });
});

describe('quietSplit with precision', () => {
    it('mutes an advisory check the team keeps dismissing, but never a proven one', () => {
        for (let i = 0; i < 5; i++) {
            recordOutcome(cwd, 'ast: Too many parameters', 'dismissed');
            recordOutcome(cwd, 'security-patterns: Hard-coded secret', 'dismissed');
        }
        const split = quietSplit(cwd, [finding('ast', 'Too many parameters'), finding('ast', 'Function too complex'), finding('security-patterns', 'Hard-coded secret')]);
        expect(split.muted).toBe(1);
        expect(split.advisory.map(f => f.title)).toEqual(['Function too complex']);
        expect(split.speaking.map(f => f.title)).toEqual(['Hard-coded secret']);
    });
});
