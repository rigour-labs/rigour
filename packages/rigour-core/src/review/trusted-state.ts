/**
 * Which copy of Rigour's own settings a review trusts.
 *
 * Dismissals, check outcomes and rigour.yml decide what a review reports. In the working tree they
 * are whatever the change under review wrote, so a pull request could dismiss its own critical
 * finding. An independent review reads them from the base instead (`ref`): a dismissal or setting
 * added by the change takes effect once it is merged, the same rule CODEOWNERS follows.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Paths that steer Rigour itself; a change touching them is called out in the review. */
export function isControlFile(file: string): boolean {
    return file === 'rigour.yml' || file.startsWith('.rigour/');
}

/** A repository file's content at `ref`, or in the working tree when no ref is given; null when absent. */
export function readStateFile(cwd: string, rel: string, ref?: string): string | null {
    if (!ref) {
        try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return null; }
    }
    const result = spawnSync('git', ['show', `${ref}:${rel.split(path.sep).join('/')}`], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
}

/** The commit a branch left `base` at: the state a pull request is judged against. */
export function mergeBaseOf(cwd: string, base: string): string {
    const result = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git merge-base ${base} HEAD failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
}
