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

    it('reads a private name by what follows its underscores, and a dunder as ambiguous', () => {
        expect(['_load_rows', '__load_rows', '_loadRows', '_Private', '_MAX_ROWS', '_run'].map(classifyCasing))
            .toEqual(['snake_case', 'snake_case', 'camelCase', 'PascalCase', 'SCREAMING_SNAKE', 'ambiguous']);
        expect(['__init__', '__name__', '__all__'].map(classifyCasing)).toEqual(Array(3).fill('ambiguous'));
        expect(classifyCasing('_')).toBe('other');
    });

    // Private names per adapter: the underscore never makes a name 'other'.
    const privates: Array<[string, string, Array<[string, string]>]> = [
        ['a.py', 'class A:\n    def __init__(self):\n        pass\n\ndef _load_rows():\n    pass\n\ndef _Helper():\n    pass\n', [['__init__', 'ambiguous'], ['_load_rows', 'snake_case'], ['_Helper', 'PascalCase']]],
        ['a.rb', 'def _load_rows\nend\n', [['_load_rows', 'snake_case']]],
        ['a.go', 'func _loadRows() {}\n', [['_loadRows', 'camelCase']]],
    ];
    for (const [file, source, expected] of privates) {
        it(`reads private names in ${file.split('.').pop()} by their casing, not as other`, () => {
            const patterns = languageAdapters.getAdapter(file)!.extractNamingPatterns(source);
            expect(expected.map(([name]) => [name, patterns.find(p => p.name === name)?.convention])).toEqual(expected);
        });
    }

    it('reads private names in TypeScript by their casing, not as other', () => {
        const patterns = extractComparableJsNames('function _loadRows() { return 1; }\nexport const _row_limit = 5;\n_loadRows();\n', 'a.ts');
        expect(patterns.map(p => [p.name, p.convention])).toEqual([['_loadRows', 'camelCase'], ['_row_limit', 'snake_case']]);
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

describe('a Python module constant', () => {
    it('is a constant, private or not, never a variable', () => {
        const patterns = languageAdapters.getAdapter('a.py')!.extractNamingPatterns('MAX_ROWS = 100\n_RETRY_DELAYS = (1, 2)\nrow_count = 0\n_cache = {}\n');
        expect(patterns.map(p => [p.name, p.kind, p.convention])).toEqual([
            ['MAX_ROWS', 'constant', 'SCREAMING_SNAKE'], ['_RETRY_DELAYS', 'constant', 'SCREAMING_SNAKE'],
            ['row_count', 'variable', 'snake_case'], ['_cache', 'variable', 'ambiguous'],
        ]);
    });
});
