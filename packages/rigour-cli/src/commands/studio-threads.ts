/**
 * What Studio reads from the repository's git folder (the common one, shared by every worktree): the task threads
 * every hook and review appends to, and the reviewer's store. Read only; a folder outside git has neither.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { THREADS_DIR, type ThreadEvent } from '@rigour-labs/core';
import { jsonLines } from './studio-files.js';

/** The repository's common git folder, absolute; undefined outside a git repository. */
export function gitCommonDir(cwd: string): string | undefined {
    // Relative to cwd on git before 2.31 (no --path-format), as core's threadsDir reads it.
    const out = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 });
    return out.status === 0 && out.stdout.trim() ? path.resolve(cwd, out.stdout.trim()) : undefined;
}

/** Every thread's events, oldest first; lines that do not parse are skipped. */
export function threadEvents(common: string | undefined): ThreadEvent[] {
    if (!common) return [];
    const dir = path.join(common, THREADS_DIR);
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    return files.flatMap(file => jsonLines<ThreadEvent>(path.join(dir, file)))
        .filter(e => typeof e?.at === 'string' && typeof e.kind === 'string')
        .sort((a, b) => a.at.localeCompare(b.at));
}
