/**
 * The edit hook, per repository: an agent session can edit files in several repositories, and
 * each file is checked against, and recorded in, the repository it belongs to.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { recordFixLessons, recordReviewOutcome, type Failure, type HookCheckerResult } from '@rigour-labs/core';

/** Findings about the write or the file's size, not a defect in the code: never stories. */
const NOT_CODE = new Set(['file-guard', 'agent-scope', 'hook-timeout', 'file-size']);

/** Files grouped by the git repository that holds them; a file outside any repository stays with `cwd`. */
export function groupFilesByRepo(cwd: string, files: string[]): Array<{ root: string; files: string[] }> {
    const rootOf = new Map<string, string>();
    const groups = new Map<string, string[]>();
    for (const file of files) {
        const abs = path.resolve(cwd, file);
        const dir = path.dirname(abs);
        if (!rootOf.has(dir)) {
            const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
            rootOf.set(dir, top.status === 0 ? top.stdout.trim() : cwd);
        }
        const root = rootOf.get(dir)!;
        groups.set(root, [...(groups.get(root) ?? []), path.relative(root, abs)]);
    }
    return [...groups].map(([root, grouped]) => ({ root, files: grouped }));
}

/** The code findings of one hook run, as review findings: what fix capture and stories need. */
export function hookFindings(result: HookCheckerResult): Failure[] {
    return result.failures
        .filter(f => f.file && !NOT_CODE.has(f.gate))
        .map(f => ({ id: f.gate, title: f.message, details: f.message, severity: f.severity, files: [f.file], ...(f.line ? { line: f.line } : {}) }) as Failure);
}

/** Open what this edit introduced and resolve what it fixed; fixes become stories and lessons. */
export async function recordEditCatches(root: string, result: HookCheckerResult, files: string[]): Promise<void> {
    const capture = recordReviewOutcome(root, hookFindings(result), files, 'edit');
    await recordFixLessons(root, capture.fixes).catch(() => undefined); // learning never blocks an edit
}
