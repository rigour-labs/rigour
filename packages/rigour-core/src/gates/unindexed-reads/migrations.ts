/**
 * The repository's SQL migrations, grouped into the databases they build: each
 * `migrations` directory is replayed on its own, its files in filename order.
 */
import fs from 'fs-extra';
import path from 'path';
import { FileScanner } from '../../utils/scanner.js';

const DEFAULT_MIGRATIONS = ['**/migrations/**/*.sql'];

/** One list of SQL texts per migrations directory, each in apply (filename) order. */
export async function loadMigrationSets(cwd: string, globs: string[], ignore: string[]): Promise<string[][]> {
    const files = await FileScanner.findFiles({ cwd, patterns: globs.length ? globs : DEFAULT_MIGRATIONS, ignore });
    const byDirectory = new Map<string, string[]>();
    for (const file of files) {
        const directory = migrationsRoot(file);
        if (!byDirectory.has(directory)) byDirectory.set(directory, []);
        byDirectory.get(directory)!.push(file);
    }
    return Promise.all([...byDirectory.values()].map(group => Promise.all(group.sort().map(file => fs.readFile(path.join(cwd, file), 'utf-8')))));
}

/** The directory a migration belongs to: up to and including its `migrations` segment, else its own folder. */
function migrationsRoot(file: string): string {
    const parts = file.split('/');
    const at = parts.lastIndexOf('migrations');
    return at >= 0 ? parts.slice(0, at + 1).join('/') : path.posix.dirname(file);
}
