import { describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { splitIntroduced } from './baseline.js';

const finding = (file: string, title: string, details = 'd'): Failure => ({ id: 'AST_COMPLEXITY', title, details, files: [file] } as Failure);

describe('splitIntroduced', () => {
    it("drops what the base already had, even when the change moved its numbers", () => {
        const base = { failures: [finding('a.ts', "Function 'f' has complexity of 105 (max: 10)", 'L12: x')], added: new Set<string>() };
        const head = [finding('a.ts', "Function 'f' has complexity of 109 (max: 10)", 'L19: x'), finding('a.ts', "Function 'g' has complexity of 11 (max: 10)")];
        const split = splitIntroduced(head, base);
        expect(split.preexisting.map(f => f.title)).toEqual(["Function 'f' has complexity of 109 (max: 10)"]);
        expect(split.introduced.map(f => f.title)).toEqual(["Function 'g' has complexity of 11 (max: 10)"]);
    });

    it('matches each base finding once, so a second copy of an old problem is new', () => {
        const old = finding('a.ts', 'Unhandled promise', 'L3: then');
        const split = splitIntroduced([old, finding('a.ts', 'Unhandled promise', 'L9: then')], { failures: [old], added: new Set() });
        expect(split.preexisting).toHaveLength(1);
        expect(split.introduced).toHaveLength(1);
    });

    it('never treats a finding in a file the change adds as old', () => {
        const f = finding('new.ts', 'Naming drift');
        expect(splitIntroduced([f], { failures: [f], added: new Set(['new.ts']) }).introduced).toEqual([f]);
    });
});
