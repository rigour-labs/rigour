/**
 * What the agent hooks remember per session, kept outside the workspace (utils/user-state.ts)
 * so the agent being reviewed cannot rewrite it:
 *   - baseline: the commit HEAD was at when the session first edited a file. The stop review
 *     covers everything since then, so committing mid-session hides nothing.
 *   - attempts: how many times the stop review has blocked this session.
 *   - taught: the team lessons and rules the stop review already put to the agent, so each is asked once.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { repoStateDir } from '../utils/user-state.js';

interface SessionEntry {
    baseline?: string;
    attempts?: number;
    /** The state of the work when the stop review last ran (workFingerprint). */
    reviewed?: string;
    /** Keys of the team knowledge already shown to this session. */
    taught?: string[];
    at: number;
}

type SessionStore = Record<string, SessionEntry>;

/** Sessions untouched this long are forgotten, so the store stays small. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function storePath(cwd: string): string {
    return path.join(repoStateDir(cwd), 'sessions.json');
}

function readStore(cwd: string): SessionStore {
    try {
        return JSON.parse(fs.readFileSync(storePath(cwd), 'utf8'));
    } catch {
        return {};
    }
}

function update(cwd: string, session: string, change: (entry: SessionEntry) => SessionEntry): SessionEntry {
    const store = readStore(cwd);
    const now = Date.now();
    for (const [id, entry] of Object.entries(store)) if (now - entry.at > SESSION_TTL_MS) delete store[id];
    store[session] = { ...change(store[session] ?? { at: now }), at: now };
    fs.mkdirSync(path.dirname(storePath(cwd)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(storePath(cwd), JSON.stringify(store), { mode: 0o600 });
    return store[session];
}

/** Record where the session started, once; later calls keep the first commit. */
export function recordSessionBaseline(cwd: string, session: string): void {
    if (!session || readStore(cwd)[session]?.baseline) return;
    const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd, encoding: 'utf8' });
    if (head.status !== 0) return; // no commits yet: the working-tree review already covers everything
    update(cwd, session, entry => ({ ...entry, baseline: head.stdout.trim() }));
}

/** The commit the session started from, if it is still in history (a rebase can drop it). */
export function sessionBaseline(cwd: string, session: string): string | undefined {
    const baseline = readStore(cwd)[session]?.baseline;
    if (!baseline) return undefined;
    const known = spawnSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { cwd });
    return known.status === 0 ? baseline : undefined;
}

/**
 * The state of the work: HEAD, the uncommitted diff, and the new files with their size and time.
 * A stop in the same state as the last review (a turn that only read, or only talked) has
 * nothing new to review, so the agent is not told the same thing again.
 */
export function workFingerprint(cwd: string, ownOutputs: string[] = DEFAULT_OWN_OUTPUTS): string | undefined {
    const run = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // Rigour's own files change on every review; where a repository does not ignore them, they must not count as work.
    const pathspec = ['--', '.', ...ownOutputs.map(own => `:(exclude)${own}`)];
    const head = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    const diff = run(['diff', 'HEAD', '--no-color', '--no-ext-diff', ...pathspec]);
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z', ...pathspec]);
    if (diff.status !== 0 || untracked.status !== 0) return undefined;
    const hash = createHash('sha256').update(head.stdout).update(diff.stdout);
    for (const file of untracked.stdout.split('\0').filter(Boolean)) {
        try {
            const stat = fs.statSync(path.join(cwd, file));
            hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\0`);
        } catch {
            hash.update(`${file}\0gone\0`);
        }
    }
    return hash.digest('hex');
}

/** What a review writes into the repository: its state folder and its reports. */
const DEFAULT_OWN_OUTPUTS = ['.rigour', 'rigour-report.json', 'rigour-fix-packet.json'];

/** Whether the work is in the state the last stop review saw. */
export function alreadyReviewed(cwd: string, session: string, fingerprint: string | undefined): boolean {
    return !!fingerprint && readStore(cwd)[session]?.reviewed === fingerprint;
}

export function recordReviewed(cwd: string, session: string, fingerprint: string | undefined): void {
    if (fingerprint) update(cwd, session, entry => ({ ...entry, reviewed: fingerprint }));
}

/** This stop's attempt number: blocks so far plus one. */
export function nextStopAttempt(cwd: string, session: string): number {
    return update(cwd, session, entry => ({ ...entry, attempts: (entry.attempts ?? 0) + 1 })).attempts ?? 1;
}

/** The agent finished cleanly: the next stop starts counting again. The baseline stays. */
export function clearStopAttempts(cwd: string, session: string): void {
    if (readStore(cwd)[session]?.attempts) update(cwd, session, entry => ({ ...entry, attempts: 0 }));
}

/** Of these team-knowledge keys, the ones this session has not been shown yet. */
export function untaught(cwd: string, session: string, keys: string[]): string[] {
    const taught = new Set(readStore(cwd)[session]?.taught ?? []);
    return keys.filter(key => !taught.has(key));
}

export function recordTaught(cwd: string, session: string, keys: string[]): void {
    if (keys.length) update(cwd, session, entry => ({ ...entry, taught: [...new Set([...(entry.taught ?? []), ...keys])] }));
}
