/**
 * A lock and an atomic write for a JSON file that more than one process writes (the review lessons store, the team
 * decisions this clone received).
 */
import fs from 'fs';
import path from 'path';

/** How long a writer waits for another to finish, and when a lock is taken as left by a writer that died. */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;

/**
 * Runs `work` holding `<file>.lock`, created exclusively. A writer holds it only to read, change and write the file,
 * so a lock older than LOCK_STALE_MS was left by a writer that died, and is taken over. Waits at most LOCK_WAIT_MS for
 * another writer, then throws `<what> is locked by another writer`, so nothing is silently lost.
 */
export function withFileLock<T>(file: string, what: string, work: () => T): T {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const until = Date.now() + LOCK_WAIT_MS;
    for (;;) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx'));
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() > until) throw new Error(`${what} is locked by another writer (${lock}); try again`);
            const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
            if (age > LOCK_STALE_MS) { fs.rmSync(lock, { force: true }); continue; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
        }
    }
    try {
        return work();
    } finally {
        fs.rmSync(lock, { force: true });
    }
}

/** Writes the whole file at once: a reader sees the old file or the new one, never half of one. */
export function writeJsonAtomic(file: string, value: unknown, mode?: number): void {
    const temp = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode });
        fs.renameSync(temp, file);
    } finally {
        fs.rmSync(temp, { force: true });
    }
}
