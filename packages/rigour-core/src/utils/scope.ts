/**
 * File scope for `rigour check <paths...>` and `rigour review`.
 *
 * CLI inputs may be absolute, relative or directories. Gates glob with
 * globby, so each input becomes a cwd-relative glob with glob-special
 * characters escaped (Next.js routes such as `app/[key]/route.ts` would
 * otherwise be read as a character class).
 */
import path from 'path';
import fs from 'fs-extra';
import { convertPathToPattern } from 'globby';
import { FileScanner } from './scanner.js';

/** Convert CLI path arguments into cwd-relative, escaped glob patterns. */
export async function normalizeScopePatterns(cwd: string, inputs: string[]): Promise<string[]> {
    const patterns: string[] = [];
    for (const input of inputs) {
        const absolute = path.resolve(cwd, input);
        const relative = toPosix(path.relative(cwd, absolute)) || '.';
        const isDirectory = await fs.stat(absolute).then(s => s.isDirectory()).catch(() => false);
        if (!isDirectory && !(await fs.pathExists(absolute))) {
            // Not a path on disk: keep it as the glob the user wrote.
            patterns.push(toPosix(input));
            continue;
        }
        const escaped = relative === '.' ? '' : convertPathToPattern(relative);
        patterns.push(isDirectory ? (escaped ? `${escaped}/**/*` : '**/*') : escaped);
    }
    return patterns;
}

/** True when a gate context carries an explicit file scope. */
export function isScoped(patterns: string[] | undefined): patterns is string[] {
    return Array.isArray(patterns) && patterns.length > 0;
}

/** True when any of `files` is in the scoped file set (paths compared cwd-relative). */
export function touchesScope(files: string[] | undefined, scopedFiles: Set<string>): boolean {
    return (files ?? []).some(f => scopedFiles.has(toPosix(f).replace(/^\.\//, '')));
}

/** The concrete cwd-relative files matched by a scoped run's patterns. */
export async function resolveScopedFiles(cwd: string, patterns: string[], ignore?: string[]): Promise<Set<string>> {
    const files = await FileScanner.findFiles({ cwd, patterns, ignore });
    return new Set(files.map(toPosix));
}

/** True when a scoped run does not include `file` (a manifest such as package.json). */
export async function scopeExcludes(context: { cwd: string; patterns?: string[]; ignore?: string[] }, file: string): Promise<boolean> {
    if (!isScoped(context.patterns)) return false;
    return !(await resolveScopedFiles(context.cwd, context.patterns, context.ignore)).has(file);
}

export function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}
