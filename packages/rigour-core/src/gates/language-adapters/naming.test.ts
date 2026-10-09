import { describe, expect, it } from 'vitest';
import { extractComparableJsNames } from '../js-style-context.js';
import { languageAdapters } from './index.js';
import { classifyCasing } from './types.js';

describe('a name\'s casing', () => {
    it('is ambiguous for one lowercase word: it is camelCase and snake_case alike', () => {
        expect(['run', 'main', 'data', 'rows', 'x', 'v2'].map(classifyCasing)).toEqual(Array(6).fill('ambiguous'));
        expect(['loadRows', 'load_rows', 'LoadRows', 'MAX_ROWS', 'MAX', 'load-rows'].map(classifyCasing))
            .toEqual(['camelCase', 'snake_case', 'PascalCase', 'SCREAMING_SNAKE', 'SCREAMING_SNAKE', 'kebab-case']);
    });

    // One source per adapter: a one-word name is ambiguous, a multi-word one keeps its casing.
    const sources: Array<[string, string, string, string]> = [
        ['a.py', 'def run():\n    pass\n\ndef load_rows():\n    pass\n', 'run', 'load_rows'],
        ['a.go', 'func run() {}\nfunc loadRows() {}\n', 'run', 'loadRows'],
        ['a.rb', 'def run\nend\ndef load_rows\nend\n', 'run', 'load_rows'],
        ['a.rs', 'fn run() {}\nfn load_rows() {}\n', 'run', 'load_rows'],
        ['A.java', 'class A {\n  public void run() {}\n  public void loadRows() {}\n}\n', 'run', 'loadRows'],
    ];
    for (const [file, source, oneWord, multiWord] of sources) {
        it(`is ambiguous for a one-word name in ${file.split('.').pop()}, and kept for a multi-word one`, () => {
            const patterns = languageAdapters.getAdapter(file)!.extractNamingPatterns(source);
            expect(patterns.find(p => p.name === oneWord)?.convention).toBe('ambiguous');
            expect(patterns.find(p => p.name === multiWord)?.convention).toBe(classifyCasing(multiWord));
            expect(classifyCasing(multiWord)).not.toBe('ambiguous');
        });
    }

    it('stays PascalCase for a one-word C# method: C# names only PascalCase methods, never a lowercase word', () => {
        const patterns = languageAdapters.getAdapter('A.cs')!.extractNamingPatterns('class A {\n  public void Run() {}\n  public void LoadRows() {}\n}\n');
        expect(patterns.filter(p => p.kind === 'method').map(p => [p.name, p.convention])).toEqual([['Run', 'PascalCase'], ['LoadRows', 'PascalCase']]);
    });

    it('is ambiguous for a one-word name in TypeScript, and kept for a multi-word one', () => {
        const patterns = extractComparableJsNames('export function run() { return 1; }\nexport function loadRows() { return 2; }\n', 'a.ts');
        expect(patterns.map(p => [p.name, p.convention])).toEqual([['run', 'ambiguous'], ['loadRows', 'camelCase']]);
    });
});
