/**
 * A judge must not outlive Rigour. Rigour ends it itself after an answer, a timeout or a signal it can catch
 * (on-termination.ts), but a `kill -9` gives it no chance: the judge, in a process group of its own, would run on. So
 * each judge has a watchdog, a small process of its own that checks every half second whether Rigour is alive; once it
 * is not, it ends the judge's group and every process still working in the copy, then exits. It exits by itself once
 * the judge's group is gone, and Rigour stops it when the run ends.
 */
import { spawn } from 'child_process';

/** The watchdog: argv is Rigour's pid, the judge's group, the copy. Plain JavaScript, so it runs from source and build alike. */
const WATCHDOG = `
const [parent, group, copy] = [Number(process.argv[1]), Number(process.argv[2]), process.argv[3]];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const timer = setInterval(() => {
    if (!alive(-group)) process.exit(0);
    if (alive(parent)) return;
    try { process.kill(-group, 'SIGKILL'); } catch {}
    const listed = require('child_process').spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8' }).stdout || '';
    let pid = 0;
    for (const line of listed.split('\\n')) {
        if (line[0] === 'p') pid = Number(line.slice(1));
        else if (line[0] === 'n' && (line.slice(1) === copy || line.slice(1).startsWith(copy + '/'))) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
    clearInterval(timer);
    process.exit(0);
}, 500);
`;

/** Starts the watchdog for the judge `pid` working in `copy`; the returned function stops it. */
export function watchJudge(pid: number, copy: string): () => void {
    if (process.platform === 'win32') return () => undefined;
    const dog = spawn(process.execPath, ['-e', WATCHDOG, String(process.pid), String(pid), copy], { detached: true, stdio: 'ignore' });
    dog.unref();
    return () => {
        try {
            if (dog.pid) process.kill(dog.pid, 'SIGKILL');
        } catch {
            // already exited
        }
    };
}
