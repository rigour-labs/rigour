/**
 * Type-checked lint rules the repository does not enable yet, on changed lines only. They are the
 * mechanical dead-code classes a person keeps finding after lint is green: a condition that can
 * never be true once the types say so, a `?.` on a member every host supplies, a redundant
 * comparison, a promise nobody awaits. The overlay loads the repository's own flat config first,
 * so nothing it enforces is lost, and uses its own `typescript-eslint` (never a download). A
 * message on a line the change did not touch is the team's backlog: counted, not blocking.
 */
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const CONFIG_FILES = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts'];
const TYPED_RULES = {
    '@typescript-eslint/no-unnecessary-condition': 'error',
    '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-redundant-type-constituents': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
};

export interface OverlayMessage { file: string; line: number; column: number; rule: string; message: string }

/** Why the overlay cannot run here, or undefined when it can. */
export function overlayUnavailable(cwd: string): string | undefined {
    if (!CONFIG_FILES.some(name => fs.existsSync(path.join(cwd, name)))) return 'no eslint.config.* in this repository';
    try {
        createRequire(path.join(cwd, 'package.json')).resolve('typescript-eslint');
    } catch {
        return 'typescript-eslint is not installed';
    }
    return undefined;
}

/**
 * Writes the overlay config to a scratch directory and returns its path. It is an ES module that
 * imports the repository's config by absolute path, so it is never written into the repository.
 */
export function writeOverlayConfig(cwd: string): string {
    const base = CONFIG_FILES.find(name => fs.existsSync(path.join(cwd, name)))!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-lint-overlay-'));
    const file = path.join(dir, 'eslint.overlay.config.mjs');
    fs.writeFileSync(file, `import path from 'node:path';
import { createRequire } from 'node:module';
const repo = ${JSON.stringify(cwd)};
const require = createRequire(path.join(repo, 'package.json'));
const base = (await import(${JSON.stringify(pathToFileURL(path.join(cwd, base)).href)})).default;
const ts = require('typescript-eslint');
const typed = ${JSON.stringify(TYPED_RULES, null, 4)};
export default [
    ...base,
    {
        files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.svelte.ts', '**/*.svelte.js'],
        ignores: ['**/*.d.ts'],
        languageOptions: { parser: ts.parser, parserOptions: { projectService: { allowDefaultProject: ['*.mjs', 'scripts/*.mjs'] }, tsconfigRootDir: repo } },
        rules: typed,
    },
    { files: ['**/*.svelte'], rules: typed },
    // A test fake deliberately covers cases the types call impossible.
    { files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test-d.ts', '**/*.svelte.test.ts', 'tests/**', 'test/**', 'test-d/**', '**/__tests__/**', '**/__mocks__/**'], rules: { '@typescript-eslint/no-unnecessary-condition': 'off', '@typescript-eslint/no-floating-promises': 'off' } },
];
`);
    return file;
}

/** ESLint's JSON report, kept to messages on changed lines; the rest is counted. */
export function onChangedLines(json: string, cwd: string, changedLines: Record<string, Set<number>>): { blocking: OverlayMessage[]; preexisting: number } | { error: string } {
    let results: Array<{ filePath: string; messages: Array<{ line: number; column: number; ruleId: string | null; message: string }> }>;
    try {
        results = JSON.parse(json);
    } catch {
        return { error: `eslint printed no JSON: ${json.trim().slice(0, 200)}` };
    }
    const blocking: OverlayMessage[] = [];
    let preexisting = 0;
    for (const result of results) {
        const file = path.relative(cwd, result.filePath).split(path.sep).join('/');
        const lines = changedLines[file];
        for (const message of result.messages) {
            if (lines?.has(message.line)) blocking.push({ file, line: message.line, column: message.column, rule: message.ruleId ?? 'error', message: message.message });
            else preexisting++;
        }
    }
    return { blocking, preexisting };
}
