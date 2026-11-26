/**
 * What a judge's CLI keeps outside the throwaway copy, under the copy's path (run-code.ts), and its removal: after each
 * run, and, for a run that crashed before it could, at the next run_code review (sweepCliLeftovers). Only entries
 * named after a Rigour copy are touched; codex's config.toml is edited under a lock, re-read, and replaced atomically.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

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

/** Sleeps without yielding: the lock is taken from a signal handler too. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `edit` holding `<file>.rigour.lock` (taken atomically; one older than ten seconds is a crashed holder's). */
function withLock(file: string, edit: () => void): void {
    const lock = `${file}.rigour.lock`;
    for (let waited = 0; ; waited += 25) {
        try {
            fs.closeSync(fs.openSync(lock, 'wx'));
            break;
        } catch {
            const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
            if (age > 10_000 || waited > 5_000) fs.rmSync(lock, { force: true });
            pause(25);
        }
    }
    try {
        edit();
    } finally {
        fs.rmSync(lock, { force: true });
    }
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
 * Removes the trusted-project entries codex wrote into `<codexHome>/config.toml` for which `drop` says yes. codex-cli
 * 0.160.1 writes one for the directory it runs in, even with `--ignore-user-config` (a real run). Under a lock, the
 * file is re-read and replaced by an atomic rename next to its real path (a linked config.toml stays linked), with its mode.
 */
export function removeCodexTrust(codexHome: string, drop: (project: string) => boolean): void {
    let file: string;
    try {
        file = fs.realpathSync(path.join(codexHome, 'config.toml'));
    } catch {
        return;
    }
    withLock(file, () => {
        const text = fs.readFileSync(file, 'utf8');
        const kept = withoutProjects(text, drop);
        if (kept === text) return;
        const temp = `${file}.rigour-${process.pid}.tmp`;
        fs.writeFileSync(temp, kept, { mode: fs.statSync(file).mode & 0o777 });
        fs.renameSync(temp, file);
    });
}

/** The codex home a judge runs with: its own CODEX_HOME (a profile's), this process's, or ~/.codex. */
export function codexHomeOf(env: Record<string, string | undefined> | undefined, home: string = os.homedir()): string {
    return env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
}

/**
 * Removes what a crashed run left for copies under `copyPrefix` (a Rigour copy's path, up to its random part) that no
 * longer exist: Claude Code's temporary and session folders, and codex's trusted-project entries.
 */
export function sweepCliLeftovers(copyPrefix: string, codexHomes: string[], env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): void {
    const gone = (project: string) => project.startsWith(copyPrefix) && !fs.existsSync(project);
    for (const codexHome of new Set(codexHomes)) removeCodexTrust(codexHome, gone);
    const prefix = claudeName(copyPrefix);
    for (const dir of [claudeTmp(env), claudeProjects(home, env)]) {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).filter(entry => entry.startsWith(prefix))) {
            // The copy's random part, and below it its repo folder: gone when no copy root of that name exists.
            const root = path.join(path.dirname(copyPrefix), path.basename(copyPrefix) + name.slice(prefix.length).split('-')[0]);
            if (!fs.existsSync(root)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
    }
}
