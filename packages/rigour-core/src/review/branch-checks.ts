/**
 * Checks on a branch as a whole, not on the lines it changed, run before an agent stops or pushes:
 *
 * - merge-conflict: the branch no longer merges cleanly into main. A reviewer cannot approve it,
 *   and CI on the merge result never runs. `git merge-tree --write-tree` (git 2.38+) answers without
 *   touching the working tree; its exit status, not `--quiet`, says whether it conflicts.
 * - stale-reference: a file the branch deleted is still named in another file (a comment, a doc,
 *   a script), so the next reader follows a path that no longer exists.
 *
 * Both are certain, so both block; neither reads beyond git and the files it names.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Config, Failure } from '../types/index.js';
import { ownOutputs } from './unused-exports.js';

const GIT_TIMEOUT_MS = 30_000;
/** Files a deleted path can still be named in: code, docs, config and scripts. */
const MENTIONER = /\.(ts|tsx|js|jsx|mjs|cjs|svelte|md|mdx|json|ya?ml|toml|sh)$/;

export function branchFailures(cwd: string, base: string, mainRef: string, config: Config): Failure[] {
    return [...mergeConflicts(cwd, mainRef), ...staleReferences(cwd, base, config)];
}

/** Files that conflict when the branch merges into `mainRef`; empty when it merges cleanly or git cannot say. */
export function mergeConflicts(cwd: string, mainRef: string): Failure[] {
    const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', mainRef], { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (result.status !== 1) return []; // 0: clean; anything else: git too old or the refs unknown
    const files = result.stdout.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    const main = mainRef.replace(/^refs\/(remotes\/|heads\/)/, '');
    return [...new Set(files)].map(file => ({
        id: 'merge-conflict',
        title: 'Merge conflict',
        details: `\`${file}\` conflicts with \`${main}\`: the branch no longer merges cleanly.`,
        severity: 'high',
        provenance: 'traditional',
        files: [file],
        line: 1,
        hint: `Merge or rebase onto \`${main}\` and resolve \`${file}\`.`,
    }));
}

/** Places that still name a file the branch deleted (since `base`). */
export function staleReferences(cwd: string, base: string, config: Config): Failure[] {
    const deleted = git(cwd, ['diff', '--name-only', '--diff-filter=D', base])?.split('\n').filter(Boolean) ?? [];
    if (deleted.length === 0) return [];
    const own = ownOutputs(config);
    const files = git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard'])?.split('\n')
        .filter(file => file && MENTIONER.test(file) && !own.some(o => file === o || file.startsWith(`${o}/`))) ?? [];
    // The whole path, not a prefix of a longer one: a deleted `src/a.ts` is not `src/a.tsx`.
    const mentions = deleted.map(gone => [gone, new RegExp(`(?<![\\w./-])${gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./-])`)] as const);
    const failures: Failure[] = [];
    for (const file of files) {
        let text: string;
        try {
            text = fs.readFileSync(path.join(cwd, file), 'utf8');
        } catch {
            continue;
        }
        const lines = text.split('\n');
        for (const [gone, pattern] of mentions) {
            const index = lines.findIndex(line => pattern.test(line));
            if (index >= 0) failures.push(stale(file, index + 1, gone));
        }
    }
    return failures;
}

function stale(file: string, line: number, gone: string): Failure {
    return {
        id: 'stale-reference',
        title: 'Reference to a deleted file',
        details: `\`${file}\` still names \`${gone}\`, which this branch deleted.`,
        severity: 'medium',
        provenance: 'traditional',
        files: [file],
        line,
        hint: `Update or remove the mention of \`${gone}\`.`,
    };
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : undefined;
}
