import { describe, expect, it } from 'vitest';
import { jsonText } from './json-file.js';

describe("a JSON config in the file's own style", () => {
    it('keeps the indent of the file it rewrites, and uses 2 spaces for a new one', () => {
        const value = { a: { b: 1 } };
        expect(jsonText(value, '{\n  "x": 1\n}\n')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
        expect(jsonText(value, '{\n    "x": 1\n}\n')).toBe('{\n    "a": {\n        "b": 1\n    }\n}\n');
        expect(jsonText(value, '{\n\t"x": 1\n}\n')).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n');
        expect(jsonText(value, '{"x":1}')).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n'); // no indent to follow: 2 spaces
        expect(jsonText(value)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n'); // a new file: 2 spaces
    });
});
