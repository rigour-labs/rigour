import { describe, expect, it } from 'vitest';
import { buildCodeContext } from './code-context.js';
import type { FileFacts, FunctionFact } from './fact-extractor.js';

function fn(name: string, lineStart: number, lineEnd: number): FunctionFact {
    return {
        name, lineStart, lineEnd, lineCount: lineEnd - lineStart + 1, paramCount: 0, params: [],
        maxNesting: 1, hasReturn: true, isAsync: false, isExported: true,
    };
}

function facts(path: string, functions: FunctionFact[]): FileFacts {
    return {
        path, language: 'typescript', lineCount: 0, classes: [], functions, imports: [], exports: [],
        errorHandling: [], testAssertions: 0, hasTests: false,
    };
}

const source = (n: number) => Array.from({ length: n }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

describe('buildCodeContext', () => {
    it('sends a small file whole, with line numbers', () => {
        const ctx = buildCodeContext(facts('src/a.ts', []), 'const a = 1;\nexport { a };', { maxChars: 10_000 });
        expect(ctx.text).toBe('FILE: src/a.ts (typescript, 2 lines)\n1| const a = 1;\n2| export { a };');
        expect(ctx.ranges).toEqual([[1, 2]]);
        expect(ctx.source).toContain('export { a }');
    });

    it('cuts a large file into function segments and names what it omitted', () => {
        const content = source(300);
        const ctx = buildCodeContext(facts('src/big.ts', [fn('first', 1, 100), fn('second', 101, 200), fn('third', 201, 300)]), content, { maxChars: 4_000 });
        expect(ctx.ranges[0]).toEqual([1, 100]);
        expect(ctx.text).toMatch(/omitted for size: .*function second \(lines 101-200\)/);
        expect(ctx.text).toContain('function third (lines 201-300)');
        expect(ctx.source).not.toContain('line150 ');
    });

    it('puts the segment around changed lines first', () => {
        const content = source(300);
        const ctx = buildCodeContext(facts('src/big.ts', [fn('first', 1, 100), fn('second', 101, 200), fn('third', 201, 300)]), content, {
            maxChars: 4_000, focusLines: [250],
        });
        expect(ctx.ranges[0]).toEqual([201, 300]);
        expect(ctx.text).toContain('function first (lines 1-100)');
    });

    it('truncates a single oversized function explicitly instead of dropping it', () => {
        const content = source(2_000);
        const ctx = buildCodeContext(facts('src/huge.ts', [fn('huge', 1, 2_000)]), content, { maxChars: 2_000 });
        expect(ctx.ranges).toHaveLength(1);
        expect(ctx.ranges[0][0]).toBe(1);
        expect(ctx.ranges[0][1]).toBeLessThan(2_000);
        expect(ctx.text).toMatch(/… \[\d+ lines omitted\]$/);
        expect(ctx.text.length).toBeLessThanOrEqual(2_000);
    });
});
