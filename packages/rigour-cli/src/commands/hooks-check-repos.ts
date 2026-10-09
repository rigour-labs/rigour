/**
 * The edit hook, per repository: an agent session can edit files in several repositories, and
 * each file is checked against, and recorded in, the repository it belongs to.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { recheckOpenFindings, recordFixLessons, recordReviewOutcome, runHookChecker, type Failure, type HookCheckerResult } from '@rigour-labs/core';

/** Findings about the write or the file's size, not a defect in the code: never stories. */
const NOT_CODE = new Set(['file-guard', 'agent-scope', 'hook-timeout', 'file-size']);

/** Files grouped by the git repository that holds them; a file outside any repository stays with `cwd`. */
export function groupFilesByRepo(cwd: string, files: string[]): Array<{ root: string; files: string[] }> {
    const rootOf = new Map<string, string>();
    const groups = new Map<string, string[]>();
    for (const file of files) {
        // Real paths on both sides: on Windows git prints C:/Users/name/… while Node may hold the
        // short C:\Users\NAME~1\… form, and a relative path between the two is nonsense.
        const abs = path.join(realDir(path.dirname(path.resolve(cwd, file))), path.basename(file));
        const dir = path.dirname(abs);
        if (!rootOf.has(dir)) {
            const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
            rootOf.set(dir, top.status === 0 ? realDir(top.stdout.trim()) : realDir(cwd));
        }
        const root = rootOf.get(dir)!;
        groups.set(root, [...(groups.get(root) ?? []), path.relative(root, abs).split(path.sep).join('/')]);
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
    // After an upgrade, what the old checks reported on earlier edits is checked again by these: never credited as a fix.
    await recheckEditFindings(root).catch(() => undefined);
    const capture = recordReviewOutcome(root, hookFindings(result), files, 'edit');
    await recordFixLessons(root, capture.fixes).catch(() => undefined); // learning never blocks an edit
}

/** Re-checks the per-edit findings another version of the checks opened (with `all`, every open one), with this version's checks (agent-fixes.ts). */
export function recheckEditFindings(root: string, all = false): Promise<{ closed: number; kept: number }> {
    return recheckOpenFindings(root, 'edit', async files => hookFindings(await runHookChecker({ cwd: root, files: files.map(f => path.join(root, f)) })), all);
}

/** The directory's real, long-form path; the path as given when it cannot be resolved (deleted, for example). */
function realDir(dir: string): string {
    try {
        return fs.realpathSync.native(dir);
    } catch {
        return path.resolve(dir);
    }
}
