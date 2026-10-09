import { describe, expect, it } from 'vitest';
import { codeColumns, codeOffsets } from './code-mask.js';

const code = (line: string, ext: string) => {
    const isCode = codeColumns(line, ext);
    return [...line].map((_, i) => (isCode(i) ? 'c' : '.')).join('');
};

describe('the code mask', () => {
    it('masks string literals with escapes, and a line comment by its language', () => {
        expect(code('a = "x\\"y" + b', 'py')).toBe('cccc......cccc');
        expect(code("f(x)  # g(y)", 'py')).toBe('cccccc......');
        expect(code('f(x); // g(y)', 'ts')).toBe('cccccc.......');
        expect(code('s = `t ${u}`', 'ts')).toBe('cccc........'); // an interpolation counts as string
    });

    it('leaves an unclosed quote as code, and starts every line as code', () => {
        expect(code("const q = /\"/;", 'ts')).toBe('cccccccccccccc');
        const isCode = codeOffsets('const q = /"/;\neval(req.body);\n', 'ts');
        expect(isCode('const q = /"/;\n'.length)).toBe(true);
    });
});
