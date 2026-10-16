/**
 * What Studio reads from the repository's git folder (the common one, shared by every worktree): the task threads
 * every hook and review appends to, and the reviewer's store. Read only; a folder outside git has neither.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { THREADS_DIR, type ThreadEvent } from '@rigour-labs/core';

/** The repository's common git folder, absolute; undefined outside a git repository. */
export function gitCommonDir(cwd: string): string | undefined {
    const out = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
    return out.status === 0 && out.stdout.trim() ? out.stdout.trim() : undefined;
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

/** A JSON-lines file's records; none when it is missing, and a line that does not parse is skipped. */
export function jsonLines<T>(file: string): T[] {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
    });
}

/** A JSON file's contents, or undefined when it is missing or does not parse. */
export function readJsonFile<T>(file: string): T | undefined {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}
