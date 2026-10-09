import { globby } from 'globby';
import micromatch from 'micromatch';
import fs from 'fs-extra';
import path from 'path';
import type { FileSystemCache } from '../services/filesystem-cache.js';
import { directoriesAsGlobs, withDirectoryForms } from './glob-paths.js';

export interface ScannerOptions {
    cwd: string;
    patterns?: string[];
    ignore?: string[];
}

/**
 * Glob patterns use `/` as the separator and `\` as the escape character.
 * Only on Windows can a backslash be a path separator, and even there one
 * that escapes a glob character (`\[` in `app/\[key\]/route.ts`) must stay.
 * Same rule as fast-glob's convertPathToPattern for Windows paths.
 */
function toGlobSeparators(pattern: string): string {
    if (process.platform !== 'win32') return pattern;
    return pattern.replace(/\\(?![!()+@[\]{}])/g, '/');
}

export class FileScanner {
    private static DEFAULT_PATTERNS = ['**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,rb,cs,java,kt,css,html,md,yaml,yml,toml,json}'];
    private static DEFAULT_IGNORE = [
        '**/node_modules/**',
        '**/dist/**',
        '**/studio-dist/**',
        '**/.next/**',
        '**/coverage/**',
        '**/out/**',
        '**/target/**',
        '**/examples/**',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/.git/**',
        'rigour-report.json'
    ];

    static async findFiles(options: ScannerOptions): Promise<string[]> {
        const patterns = (options.patterns || this.DEFAULT_PATTERNS).map(toGlobSeparators);
        const userIgnore = options.ignore || [];
        const ignore = [...new Set([...this.DEFAULT_IGNORE, ...userIgnore])].map(toGlobSeparators);
        const normalizedCwd = options.cwd.replace(/\\/g, '/');

        // Sorted: the walk's order varies run to run, and a check that names "the first file" must name the same one.
        const files = await globby(directoriesAsGlobs(normalizedCwd, patterns), {
            cwd: normalizedCwd,
            ignore: withDirectoryForms(ignore),
            expandDirectories: false,
        });
        return files.sort();
    }

    /** The selection findFiles makes, over paths listed elsewhere (a commit's files) instead of the disk. */
    static filterPaths(paths: string[], options: Omit<ScannerOptions, 'cwd'>): string[] {
        const patterns = (options.patterns || this.DEFAULT_PATTERNS).map(toGlobSeparators);
        const ignore = withDirectoryForms([...new Set([...this.DEFAULT_IGNORE, ...(options.ignore || [])])].map(toGlobSeparators));
        return paths.filter(file => micromatch.isMatch(file, patterns, { ignore })).sort();
    }

    /**
     * Read file contents. When a FileSystemCache is provided, uses it for
     * shared caching across gates (avoids re-loading per gate).
     */
    static async readFiles(cwd: string, files: string[], cache?: FileSystemCache): Promise<Map<string, string>> {
        if (cache) {
            return cache.getFiles(cwd, files);
        }

        const contents = new Map<string, string>();
        for (const file of files) {
            const normalizedFile = file.replace(/\//g, path.sep);
            const filePath = path.isAbsolute(normalizedFile) ? normalizedFile : path.join(cwd, normalizedFile);
            contents.set(file, await fs.readFile(filePath, 'utf-8'));
        }
        return contents;
    }
}
