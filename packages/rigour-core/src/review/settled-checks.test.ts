import { describe, expect, it } from 'vitest';
import { againstSettled, coveredSection, onChangedLines, settledChecks, withoutCovered } from './settled-checks.js';
import { reviewerInputs } from './reviewer/context.js';

describe('settled checks', () => {
    it('settles what the checks found on the change\'s lines, and everything without a change to scope to', () => {
        const found = [
            { id: 'security-patterns', files: ['src/a.ts'], line: 3, title: 'on the change' },
            { id: 'security-patterns', files: ['src/a.ts'], line: 9, title: 'off the change' },
            { id: 'orphan-file', files: ['src/b.ts'], title: 'a whole changed file' },
            { id: 'semantic-bugs', files: ['src/c.ts'], line: 1, title: 'a file the change does not touch' },
        ];
        const focus = { 'src/a.ts': [3, 4], 'src/b.ts': [1] };
        expect(onChangedLines(found, focus).map(f => f.title)).toEqual(['on the change', 'a whole changed file']);
        expect(onChangedLines(found, undefined)).toHaveLength(4);
        expect(settledChecks(found)[0]).toEqual({ file: 'src/a.ts', line: 3, title: 'on the change', kind: 'security-patterns' });
    });

    it('calls a model finding the same issue only for the check\'s own kind; a check it cannot map is never the same', () => {
        const settled = [{ file: 'src/a.ts', line: 3, title: 'Security: XSS', kind: 'security-patterns' }, { file: 'src/a.ts', line: 5, title: 'A new check', kind: 'some-new-check' }];
        expect(againstSettled({ file: 'src/a.ts', line: 3, category: 'security' }, settled)).toEqual({ same: true, alsoAt: ['Security: XSS'] });
        expect(againstSettled({ file: 'src/a.ts', line: 3, category: 'correctness' }, settled)).toEqual({ same: false, alsoAt: ['Security: XSS'] });
        expect(againstSettled({ file: 'src/a.ts', line: 5, category: 'security' }, settled)).toEqual({ same: false, alsoAt: ['A new check'] });
        expect(againstSettled({ file: 'src/a.ts', line: 7, category: 'security' }, settled)).toEqual({ same: false, alsoAt: [] });
    });

    it('leaves out only the lessons a compiled check covered, and says which', () => {
        const covered = [{ checkId: 'c-L1', lessonId: 'L1', message: 'never fetchAll' }];
        expect(withoutCovered([{ id: 'L1' }, { id: 'L2' }], covered).map(l => l.id)).toEqual(['L2']);
        expect(withoutCovered([{ id: 'L1' }], [])).toEqual([{ id: 'L1' }]);
        expect(coveredSection(covered)).toContain('- covered by compiled check c-L1 for lesson L1: never fetchAll');
        expect(coveredSection([])).toBe('');
    });

    it('hands the judge a compiled check\'s notes as settled, with the lessons it covered', () => {
        const inputs = reviewerInputs({ hints: [], findings: [], advisory: [{ id: 'compiled-lesson', files: ['src/a.ts'], line: 3, title: 'no fetchAll' }, { id: 'unused-export', files: ['src/b.ts'], line: 1, title: 'a note' }], covered: [{ checkId: 'c-L1', lessonId: 'L1', message: 'm' }] });
        expect(inputs.checks).toEqual(['src/a.ts:3 no fetchAll']);
        expect(inputs.covered).toEqual([{ checkId: 'c-L1', lessonId: 'L1', message: 'm' }]);
    });
});
