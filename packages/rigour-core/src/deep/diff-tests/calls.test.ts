import { describe, expect, it } from 'vitest';
import { safeCalls, testFileSource } from './calls.js';

describe('safeCalls', () => {
    it('keeps calls of the function with literal arguments only', () => {
        expect(safeCalls('encodePath', [
            "encodePath('/a b')",
            "encodePath('/x?y', { keepQuery: true, depth: -1 }, [1, null, undefined]);",
            'encodePath(`/%`)',
        ])).toEqual(["encodePath('/a b')", "encodePath('/x?y', { keepQuery: true, depth: -1 }, [1, null, undefined])", 'encodePath(`/%`)']);
    });

    it('drops anything that could do more than call the function on data', () => {
        expect(safeCalls('encodePath', [
            "require('fs').rmSync('/')",
            "encodePath(process.env.HOME)",
            "encodePath((() => { fetch('x') })())",
            'encodePath(`${secret}`)',
            "other('/a')",
            "encodePath('/a'); encodePath('/b')",
            "encodePath({ [key]: 1 })",
        ])).toEqual([]);
    });
});

describe('testFileSource', () => {
    it('imports the function, runs each call and records return values or errors without asserting', () => {
        const source = testFileSource('vitest', 'encodePath', '../src/path', ["encodePath('/a b')"]);
        expect(source).toContain("import { test } from 'vitest';");
        expect(source).toContain('import { encodePath } from "../src/path";');
        expect(source).toContain(`["encodePath('/a b')", () => encodePath('/a b')],`);
        expect(source).toContain('writeFileSync(process.env.RIGOUR_DIFF_OUT as string, JSON.stringify(out));');
        expect(source).not.toContain('expect(');
        expect(testFileSource('jest', 'f', './f', ['f(1)'])).not.toContain("from 'vitest'");
    });
});
