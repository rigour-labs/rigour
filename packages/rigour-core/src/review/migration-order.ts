/**
 * Migration out of order: a migration the change adds that sorts before the
 * newest migration already on the base (the base ref, or HEAD for
 * uncommitted work).
 *
 * The Supabase CLI applies migrations in filename order and `db push` stops
 * at a local migration older than the last one applied, so a branch that
 * picked an earlier timestamp than main's newest fails or is skipped on any
 * database main already reached. Only directories listed in
 * `gates.migration_order.dirs` are checked (Supabase's by default): runners
 * that track each migration separately, such as Rails, apply older ones fine.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import micromatch from 'micromatch';
import type { Config, Failure } from '../types/index.js';
import type { DiffSource } from './git-diff.js';

const GIT_TIMEOUT_MS = 10_000;

export function migrationOrderFailures(cwd: string, diff: string, source: DiffSource | undefined, config: Config): Failure[] {
    const settings = config.gates.migration_order;
    if (!settings?.enabled) return [];
    const base = source?.mode === 'base' ? source.base : 'HEAD';
    const byDirectory = new Map<string, string[]>();
    for (const file of addedFiles(diff)) {
        const directory = path.posix.dirname(file);
        if (!file.endsWith('.sql') || !micromatch.isMatch(directory, settings.dirs)) continue;
        byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
    }
    const failures: Failure[] = [];
    for (const [directory, added] of byDirectory) {
        const newest = newestOnBase(cwd, base, directory);
        if (!newest) continue;
        for (const file of added) {
            if (path.posix.basename(file) < newest) failures.push(outOfOrder(file, newest, base));
        }
    }
    return failures;
}

/** Files a unified diff creates (`--- /dev/null`). */
export function addedFiles(diff: string): string[] {
    const added: string[] = [];
    const lines = diff.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === '--- /dev/null' && lines[i + 1].startsWith('+++ b/')) added.push(lines[i + 1].slice('+++ b/'.length));
    }
    return added;
}

/** The last .sql file name in `directory` at `base`, or undefined when git cannot say. */
function newestOnBase(cwd: string, base: string, directory: string): string | undefined {
    const result = spawnSync('git', ['ls-tree', '--name-only', base, `${directory}/`], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (result.status !== 0) return undefined;
    const names = result.stdout.split('\n').map(line => path.posix.basename(line.trim())).filter(name => name.endsWith('.sql'));
    return names.sort().at(-1);
}

function outOfOrder(file: string, newest: string, base: string): Failure {
    return {
        id: 'migration-order',
        title: 'Migration out of order',
        details: `\`${path.posix.basename(file)}\` sorts before \`${newest}\`, the newest migration on \`${base}\`. Migrations apply in filename order, so a database that already ran \`${newest}\` stops at or skips this one.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line: 1,
        hint: `Rename it with a timestamp after \`${newest}\`.`,
    };
}
