import { globby } from 'globby';
import fs from 'fs-extra';
import path from 'path';

export interface ScannerOptions {
    cwd: string;
    patterns?: string[];
    ignore?: string[];
}

export class FileScanner {
    private static DEFAULT_PATTERNS = ['**/*.{ts,js,py,css,html,md}'];
    private static DEFAULT_IGNORE = [
        '**/node_modules/**',
        '**/dist/**',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/.git/**',
        'rigour-report.json'
    ];

    static async findFiles(options: ScannerOptions): Promise<string[]> {
        const patterns = (options.patterns || this.DEFAULT_PATTERNS).map(p => p.replace(/\\/g, '/'));
        const ignore = (options.ignore || this.DEFAULT_IGNORE).map(p => p.replace(/\\/g, '/'));
        const normalizedCwd = options.cwd.replace(/\\/g, '/');

        return globby(patterns, {
            cwd: normalizedCwd,
            ignore: ignore,
        });
    }

    static async readFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
        const contents = new Map<string, string>();
        for (const file of files) {
            const normalizedFile = file.replace(/\//g, path.sep);
            const filePath = path.isAbsolute(normalizedFile) ? normalizedFile : path.join(cwd, normalizedFile);
            contents.set(file, await fs.readFile(filePath, 'utf-8'));
        }
        return contents;
    }
}
