/**
 * Ending everything a judge that runs code started (run-code.ts). The judge runs in a process group of its own, but a
 * CLI's shell need not stay in it: a `nohup` job Claude Code 2.1.285's shell left behind outlived the judge's group
 * (a real run), and once its shell exits it is no longer in the judge's process tree either. What such a
 * process keeps is its working directory, inside the throwaway copy: those are ended too. A process that leaves the
 * copy and detaches is not found; it stays inside the CLI's sandbox (docs/REVIEWER.md). Synchronous throughout, so a
 * SIGINT or SIGTERM handler can call it.
 */
import { spawnSync } from 'child_process';

const signal = (pid: number, name: NodeJS.Signals | 0 = 'SIGKILL') => {
    try {
        process.kill(pid, name);
        return true;
    } catch {
        return false;
    }
};

export const alive = (pid: number) => signal(pid, 0);

/** Ends a process group (a judge and what stayed in its group), and the judge itself; one already gone is fine. */
export function killGroup(pid: number | undefined): void {
    if (!pid || process.platform === 'win32') return;
    // ESRCH: the group is gone, and its pid may be someone else's by now: nothing more. EPERM (macOS, while the judge
    // is still exiting after a timeout, so the pid is still ours): the judge itself.
    try {
        process.kill(-pid, 'SIGKILL');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') signal(pid);
    }
}

/** Every live process below `pid`, from the process table: what the judge started, in whatever group or session. */
export function descendants(pid: number): number[] {
    const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    if (table.status !== 0) return [];
    const children = new Map<number, number[]>();
    for (const line of table.stdout.split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (child && parent) children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const found: number[] = [];
    for (const queue = [...(children.get(pid) ?? [])]; queue.length;) {
        const next = queue.shift()!;
        found.push(next);
        queue.push(...(children.get(next) ?? []));
    }
    return found;
}

/** The processes whose working directory is `dir` or below it (lsof; `dir` as the real path the system reports). */
export function processesIn(dir: string): number[] {
    const listed = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const found: number[] = [];
    let pid = 0;
    for (const line of (listed.stdout ?? '').split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && (line.slice(1) === dir || line.slice(1).startsWith(`${dir}/`)) && pid !== process.pid) found.push(pid);
    }
    return found;
}

/** Ends the judge `pid`, everything below it, its group, and any process still working in its copy `dir`. */
export function endJudgeProcesses(pid: number | undefined, dir: string): void {
    if (process.platform === 'win32') return;
    const below = pid ? descendants(pid) : [];
    killGroup(pid);
    for (const child of below) signal(child);
    for (const left of processesIn(dir)) signal(left);
}
