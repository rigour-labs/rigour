/**
 * Language detection data for promise-safety gate.
 * Extracted to keep promise-safety.ts under 500 lines.
 */

export type Lang = 'js' | 'python' | 'go' | 'ruby' | 'csharp' | 'unknown';

export const LANG_EXTENSIONS: Record<string, Lang> = {
    '.ts': 'js', '.tsx': 'js', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
    '.py': 'python', '.pyw': 'python',
    '.go': 'go',
    '.rb': 'ruby', '.rake': 'ruby',
    '.cs': 'csharp',
};

export const LANG_GLOBS: Record<Lang, string[]> = {
    js:      ['**/*.{ts,js,tsx,jsx,mjs,cjs}'],
    python:  ['**/*.py'],
    go:      ['**/*.go'],
    ruby:    ['**/*.rb'],
    csharp:  ['**/*.cs'],
    unknown: [],
};
