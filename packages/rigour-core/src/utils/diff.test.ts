import { describe, expect, it } from 'vitest';
import { changedLinesByFile, parseDiff } from './diff.js';

const lines = (m: Record<string, Set<number>>) => changedLinesByFile(m);

describe('parseDiff', () => {
    it('maps added lines to new-side line numbers', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,3 +1,4 @@',
            ' const a = 1;',
            '-const b = 2;',
            '+const b = 3;',
            '+const c = 4;',
            ' export { a };',
        ].join('\n');
        expect(lines(parseDiff(diff))).toEqual({ 'src/a.ts': [2, 3] });
    });

    it('handles several files and hunks', () => {
        const diff = [
            '+++ b/a.ts', '@@ -10,2 +10,3 @@', ' x', '+y', ' z',
            '+++ b/b.ts', '@@ -1 +1 @@', '-old', '+new',
        ].join('\n');
        expect(lines(parseDiff(diff))).toEqual({ 'a.ts': [11], 'b.ts': [1] });
    });

    it('does not mistake content lines starting with +++ or --- for headers', () => {
        const diff = ['+++ b/a.ts', '@@ -1,2 +1,3 @@', ' let i = 0;', '+++i;', '---j;', ' done();'].join('\n');
        expect(lines(parseDiff(diff))).toEqual({ 'a.ts': [2] });
    });

    it('does not count "No newline at end of file" as a line', () => {
        const diff = ['+++ b/a.ts', '@@ -1,1 +1,2 @@', ' a', '\\ No newline at end of file', '+b'].join('\n');
        expect(lines(parseDiff(diff))).toEqual({ 'a.ts': [2] });
    });

    it('ignores deleted files', () => {
        const diff = ['diff --git a/gone.ts b/gone.ts', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join('\n');
        expect(parseDiff(diff)).toEqual({});
    });
});
