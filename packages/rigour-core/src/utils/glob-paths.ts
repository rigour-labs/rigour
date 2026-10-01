import fs from 'fs';
import path from 'path';
import { isDynamicPattern } from 'globby';

/*
 * globby's default directory expansion stats every pattern and ignore entry,
 * and throws ENOTDIR when one runs through a file: `.git/**` in a git
 * worktree, where `.git` is a file. Rigour turns it off
 * (`expandDirectories: false`) and expands plain paths itself, as before:
 * a directory `legacy` also means `legacy/**`.
 */

/** Ignore entries: a plain path also ignores everything under it. Matched only, never listed. */
export function withDirectoryForms(patterns: string[]): string[] {
    return patterns.flatMap(pattern => isDynamicPattern(pattern) ? [pattern] : [pattern, `${pattern.replace(/\/+$/, '')}/**`]);
}

/** Search patterns: a plain path that is a directory becomes `dir/**`; files and globs stay. */
export function directoriesAsGlobs(cwd: string, patterns: string[]): string[] {
    return patterns.map(pattern => !isDynamicPattern(pattern) && isDirectory(path.resolve(cwd, pattern)) ? `${pattern.replace(/\/+$/, '')}/**` : pattern);
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}
