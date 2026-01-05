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
        return globby(options.patterns || this.DEFAULT_PATTERNS, {
            cwd: options.cwd,
            ignore: options.ignore || this.DEFAULT_IGNORE,
        });
    }

    static async readFiles(cwd: string, files: string[]): Promise<Map<string, string>> {
        const contents = new Map<string, string>();
        for (const file of files) {
            const filePath = path.isAbsolute(file) ? file : path.join(cwd, file);
            contents.set(file, await fs.readFile(filePath, 'utf-8'));
        }
        return contents;
    }
}
