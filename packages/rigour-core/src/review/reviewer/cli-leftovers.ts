/**
 * What a judge's CLI keeps outside the throwaway copy, under the copy's path (run-code.ts), and its removal: after each
 * run, and, for a run that crashed before it could, at the next run_code review (sweepCliLeftovers). Only entries
 * named after a Rigour copy are touched; codex's config.toml is edited under a lock, re-read, and replaced atomically,
 * and an edit that cannot be made safely is skipped with a note, never waited on without end.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ownerState, thisProcess, type Owner } from './owner-process.js';

/** Claude Code names a folder after a working directory: every character but a letter or digit a `-`. */
const claudeName = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, '-');

/** Claude Code's own temporary folder, `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>`: other sessions keep their files there. */
export function claudeTmp(env: NodeJS.ProcessEnv = process.env): string | undefined {
    try {
        return path.join(fs.realpathSync(env.CLAUDE_CODE_TMPDIR || '/tmp'), `claude-${process.getuid?.() ?? 0}`);
    } catch {
        return undefined;
    }
}

/** Where Claude Code keeps sessions, one folder per working directory. */
const claudeProjects = (home: string, env: NodeJS.ProcessEnv) => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');

/** Removes Claude Code's temporary and session folders for a run in `copy`: the copy's path is that run's alone. */
export function removeClaudeLeftovers(copy: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): void {
    const tmp = claudeTmp(env);
    for (const dir of [tmp, claudeProjects(home, env)]) if (dir) fs.rmSync(path.join(dir, claudeName(copy)), { recursive: true, force: true });
}

/** Sleeps without yielding: the lock is taken from a signal handler too, so every wait is bounded (LOCK_WAIT_MS). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCK_WAIT_MS = 5_000;

const holderOf = (lock: string): Owner | undefined => {
    try {
        return JSON.parse(fs.readFileSync(lock, 'utf8')) as Owner;
    } catch {
        return undefined; // being written, or gone
    }
};

/**
 * Takes `<file>.rigour.lock`, holding this process's pid and start time, or says why not. Only an existing lock
 * (EEXIST) is waited for, at most LOCK_WAIT_MS; any other error (a read-only folder, one owned by root) is said at once.
 * A lock is taken over only when its holder is gone (owner-process.ts), never for its age, and only if it is still
 * that holder's when it is removed.
 */
function lock(file: string): { release: () => void } | { note: string } {
    const lockFile = `${file}.rigour.lock`;
    for (const started = Date.now(); Date.now() - started <= LOCK_WAIT_MS; pause(25)) {
        try {
            const fd = fs.openSync(lockFile, 'wx', 0o600);
            fs.writeSync(fd, JSON.stringify(thisProcess()));
            fs.closeSync(fd);
            return { release: () => fs.rmSync(lockFile, { force: true }) };
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EEXIST') return { note: `could not lock ${file}: ${code ?? 'error'}; trust entry left in place` };
            const holder = holderOf(lockFile);
            if (holder && ownerState(holder) === 'gone' && JSON.stringify(holderOf(lockFile)) === JSON.stringify(holder)) fs.rmSync(lockFile, { force: true });
        }
    }
    return { note: `could not lock ${file}: another process held it for ${LOCK_WAIT_MS / 1000} s; trust entry left in place` };
}

/** `text` without the `[projects."<path>"]` tables for which `drop` says yes; every other line as it was. */
function withoutProjects(text: string, drop: (project: string) => boolean): string {
    const lines = text.split('\n');
    for (let at = lines.length - 1; at >= 0; at--) {
        const header = /^\[projects\.("(?:[^"\\]|\\.)*")\]$/.exec(lines[at]);
        if (!header || !drop(JSON.parse(header[1]))) continue;
        let end = at + 1;
        while (end < lines.length && !lines[end].startsWith('[')) end++;
        while (end > at + 1 && lines[end - 1] === '') end--; // the blank line before the next table stays
        const start = at > 0 && lines[at - 1] === '' ? at - 1 : at;
        lines.splice(start, end - start);
    }
    return lines.join('\n');
}

/**
 * Removes the trusted-project entries codex wrote into `<codexHome>/config.toml` for which `drop` says yes; returns a
 * note when it could not. codex-cli 0.160.1 writes one for the directory it runs in, even with `--ignore-user-config`
 * (a real run). Under Rigour's lock the file is read, the new text written beside its real path (a linked config.toml
 * stays linked) with its mode, read again, and renamed over it only if it did not change meanwhile. Codex itself
 * takes no lock: a write codex makes in that last instant, between the second read and the rename, would be lost.
 */
export function removeCodexTrust(codexHome: string, drop: (project: string) => boolean): string | undefined {
    let file: string;
    try {
        file = fs.realpathSync(path.join(codexHome, 'config.toml'));
    } catch {
        return undefined;
    }
    const held = lock(file);
    if ('note' in held) return held.note;
    try {
        const text = fs.readFileSync(file, 'utf8');
        const kept = withoutProjects(text, drop);
        if (kept === text) return undefined;
        const temp = `${file}.rigour-${process.pid}.tmp`;
        fs.writeFileSync(temp, kept, { mode: fs.statSync(file).mode & 0o777 });
        if (fs.readFileSync(file, 'utf8') !== text) {
            fs.rmSync(temp, { force: true });
            return `${file} changed while Rigour edited it; trust entry left in place`;
        }
        fs.renameSync(temp, file);
        return undefined;
    } catch (error) {
        return `could not edit ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}; trust entry left in place`;
    } finally {
        held.release();
    }
}

/** The codex home a judge runs with: its own CODEX_HOME (a profile's), this process's, or ~/.codex. */
export function codexHomeOf(env: Record<string, string | undefined> | undefined, home: string = os.homedir()): string {
    return env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
}

/**
 * Removes what a crashed run left for copies under `copyPrefix` (a Rigour copy's path, up to its random part) that no
 * longer exist: Claude Code's temporary and session folders, and codex's trusted-project entries.
 */
export function sweepCliLeftovers(copyPrefix: string, codexHomes: string[], env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
    const gone = (project: string) => project.startsWith(copyPrefix) && !fs.existsSync(project);
    const notes = [...new Set(codexHomes)].map(codexHome => removeCodexTrust(codexHome, gone)).filter((note): note is string => !!note);
    const prefix = claudeName(copyPrefix);
    for (const dir of [claudeTmp(env), claudeProjects(home, env)]) {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).filter(entry => entry.startsWith(prefix))) {
            // The copy's random part, and below it its repo folder: gone when no copy root of that name exists.
            const root = path.join(path.dirname(copyPrefix), path.basename(copyPrefix) + name.slice(prefix.length).split('-')[0]);
            if (!fs.existsSync(root)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
    }
    return notes;
}
