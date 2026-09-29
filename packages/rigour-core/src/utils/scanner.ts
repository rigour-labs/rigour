import { globby } from 'globby';
import fs from 'fs-extra';
import path from 'path';
import type { FileSystemCache } from '../services/filesystem-cache.js';

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

        return globby(patterns, {
            cwd: normalizedCwd,
            ignore: ignore,
        });
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
