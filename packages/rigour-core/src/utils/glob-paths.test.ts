import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileScanner } from './scanner.js';
import { directoriesAsGlobs, withDirectoryForms } from './glob-paths.js';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-paths-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'legacy'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'legacy', 'old.ts'), 'export const b = 2;\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('withDirectoryForms', () => {
    it('adds the directory form to plain paths and leaves globs alone', () => {
        expect(withDirectoryForms(['legacy', 'build/', '.git/**', '**/*.min.js'])).toEqual(['legacy', 'legacy/**', 'build/', 'build/**', '.git/**', '**/*.min.js']);
    });
});

describe('directoriesAsGlobs', () => {
    it('turns a directory into dir/** and leaves files, missing paths and globs alone', () => {
        expect(directoriesAsGlobs(root, ['src', 'src/a.ts', 'missing', '**/*.ts'])).toEqual(['src/**', 'src/a.ts', 'missing', '**/*.ts']);
    });
});

describe('FileScanner in a git worktree', () => {
    it('scans when .git is a file and the config ignores .git/**', async () => {
        fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
        const files = await FileScanner.findFiles({ cwd: root, patterns: ['**/*.ts'], ignore: ['.git/**'] });
        expect(files.sort()).toEqual(['legacy/old.ts', 'src/a.ts']);
    });

    it('finds a file or a whole directory named by a plain path', async () => {
        expect(await FileScanner.findFiles({ cwd: root, patterns: ['src/a.ts'] })).toEqual(['src/a.ts']);
        expect(await FileScanner.findFiles({ cwd: root, patterns: ['legacy'] })).toEqual(['legacy/old.ts']);
    });

    it('still ignores a whole directory named by a plain path', async () => {
        const files = await FileScanner.findFiles({ cwd: root, patterns: ['**/*.ts'], ignore: ['legacy'] });
        expect(files).toEqual(['src/a.ts']);
    });
});
