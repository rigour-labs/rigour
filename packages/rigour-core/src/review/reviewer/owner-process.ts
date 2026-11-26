/**
 * Who owns a Rigour folder or lock: a process, named by its pid and its start time (`ps -o lstart`), so a later process
 * given the same pid is told apart. Whether that owner is gone is decided only on evidence: the pid ends (ESRCH), or
 * `ps` shows another start time. When `ps` fails or is blocked, ownership is unknown, and nothing is taken.
 */
import { spawnSync } from 'child_process';

export interface Owner { pid: number; started: string }

/** When `pid` started, as `ps` says; undefined when ps could not say (it failed, or was not allowed to run). */
function startedAt(pid: number): string | undefined {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return ps.status === 0 && !ps.error ? ps.stdout.trim() || undefined : undefined;
}

/** This process, as an owner. */
export function thisProcess(): Owner {
    return { pid: process.pid, started: startedAt(process.pid) ?? '' };
}

/** Whether `owner` is gone, still running, or cannot be told. */
export function ownerState(owner: Owner): 'gone' | 'alive' | 'unknown' {
    try {
        process.kill(owner.pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    }
    const now = startedAt(owner.pid);
    if (now === undefined || !owner.started) return 'unknown';
    return now === owner.started ? 'alive' : 'gone';
}
