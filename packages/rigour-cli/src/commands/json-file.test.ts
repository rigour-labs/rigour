import { describe, expect, it } from 'vitest';
import { jsonIndent, jsonText } from './json-file.js';

describe("a JSON config in the file's own style", () => {
    it('keeps the indent of the file it rewrites, and uses 2 spaces for a new one', () => {
        expect(jsonIndent('{\n  "a": 1\n}\n')).toBe('  ');
        expect(jsonIndent('{\n    "a": 1\n}\n')).toBe('    ');
        expect(jsonIndent('{\n\t"a": 1\n}\n')).toBe('\t');
        expect(jsonIndent('{"a":1}')).toBe(2);
        expect(jsonIndent(undefined)).toBe(2);
        expect(jsonText({ a: { b: 1 } }, '{\n    "x": 1\n}\n')).toBe('{\n    "a": {\n        "b": 1\n    }\n}\n');
        expect(jsonText({ a: 1 })).toBe('{\n  "a": 1\n}\n');
    });
});
