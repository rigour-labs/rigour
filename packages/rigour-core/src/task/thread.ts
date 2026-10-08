/**
 * The engineering task: one piece of work, whatever agents and people touch it, and its thread, everything that
 * happened to it in order. The key is the ticket the branch names (`PROJ-123`), or the branch itself; a pull request
 * joins the thread when a review of it runs. Every writer appends one event to `<git dir>/rigour/threads/<key>.jsonl`,
 * never rewrites one, and never fails the hook or command it runs in: a thread is a record, not a gate. It lives in
 * the repository's own git folder, shared by its worktrees, so one task worked on in two worktrees is one thread, and
 * nothing is ever added to the working tree or committed.
 *
 * What a thread holds is what Rigour saw: hooked agent sessions (the edit check, the stop review), the push gate, and
 * reviews. Work done where no hook ran (an agent without hooks, a person in an editor) shows only through the commits
 * and reviews that follow it.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Under the repository's git folder (the common one, shared by every worktree). */
export const THREADS_DIR = 'rigour/threads';

/** A ticket key in a branch name: `feat/proj-123-thing` → `PROJ-123`. */
const TICKET = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9}-\d{1,7})(?=$|[^0-9])/;

export type TaskEventKind = 'edit-check' | 'stop-review' | 'push' | 'review' | 'brief';

export interface TaskEvent {
    kind: TaskEventKind;
    /** The agent session it happened in, when a hook knows it. */
    session?: string;
    /** The agent (claude, cursor, codex, ...) or `person`, when known. */
    agent?: string;
    /** The pull request, once a review of it ran. */
    pr?: number;
    /** What happened, in a few fields; each kind documents its own. */
    [field: string]: unknown;
}

export interface ThreadEvent extends TaskEvent {
    at: string;
    task: string;
    branch: string;
    head?: string;
}

/** The task the checkout is working on: the ticket its branch names, else the branch; undefined on a detached head. */
export function taskOf(cwd: string): { key: string; branch: string; head?: string } | undefined {
    const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']); // a branch with no commit yet has a task too
    if (!branch) return undefined;
    const ticket = TICKET.exec(branch)?.[1];
    return { key: ticket ? ticket.toUpperCase() : `branch:${branch}`, branch, head: git(cwd, ['rev-parse', 'HEAD']) };
}

/** Appends one event to the checkout's task thread. Best effort: a thread never breaks the hook or command it runs in. */
export function appendTaskEvent(cwd: string, event: TaskEvent): ThreadEvent | undefined {
    try {
        const task = taskOf(cwd);
        if (!task) return undefined;
        const line: ThreadEvent = { at: new Date().toISOString(), task: task.key, branch: task.branch, ...(task.head ? { head: task.head } : {}), ...event };
        const dir = threadsDir(cwd);
        if (!dir) return undefined;
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${fileName(task.key)}.jsonl`), JSON.stringify(line) + '\n');
        return line;
    } catch {
        return undefined;
    }
}

/**
 * The thread for a key, oldest first: a ticket (`PROJ-123`), a branch name, a pull request (`#42` or `42`), or nothing
 * for the checkout's own task. Unreadable lines are skipped, never guessed.
 */
export function readThread(cwd: string, key?: string): { task: string; events: ThreadEvent[] } | undefined {
    const wanted = key?.trim();
    const dir = threadsDir(cwd);
    if (!dir) return undefined;
    const read = (task: string) => readEvents(path.join(dir, `${fileName(task)}.jsonl`));
    if (!wanted) {
        const own = taskOf(cwd);
        return own ? { task: own.key, events: read(own.key) } : undefined;
    }
    const pr = /^#?(\d+)$/.exec(wanted)?.[1];
    if (pr) {
        for (const file of listThreads(dir)) {
            const events = readEvents(path.join(dir, file));
            if (events.some(e => e.pr === Number(pr))) return { task: events[0].task, events };
        }
        return undefined;
    }
    const ticket = TICKET.exec(wanted)?.[1];
    const task = ticket && ticket.length === wanted.length ? ticket.toUpperCase() : TICKET.exec(wanted) ? TICKET.exec(wanted)![1].toUpperCase() : `branch:${wanted.replace(/^branch:/, '')}`;
    const events = read(task);
    return events.length ? { task, events } : undefined;
}

/** The thread as a person reads it: who worked on it, what was caught and fixed, what blocked, then the events in order. */
export function threadText(thread: { task: string; events: ThreadEvent[] }): string[] {
    const { task, events } = thread;
    if (events.length === 0) return [`${task}: nothing recorded yet`];
    const sessions = new Set(events.map(e => e.session).filter(Boolean));
    const agents = [...new Set(events.map(e => e.agent).filter((a): a is string => typeof a === 'string'))];
    const prs = [...new Set(events.map(e => e.pr).filter((p): p is number => typeof p === 'number'))];
    const branches = [...new Set(events.map(e => e.branch))];
    const checks = events.filter(e => e.kind === 'edit-check');
    const caught = checks.reduce((n, e) => n + num(e.findings), 0);
    const lines = [
        `${task} · ${branches.join(', ')}${prs.length ? ` · PR ${prs.map(p => `#${p}`).join(', ')}` : ''}`,
        `${events[0].at} → ${events[events.length - 1].at} · ${sessions.size} agent session(s)${agents.length ? ` (${agents.join(', ')})` : ''}`,
        `edit checks: ${checks.length}, findings caught while writing: ${caught}${caught ? `, files clean again after a finding: ${cleanedAfter(checks)}` : ''}`,
    ];
    const stops = events.filter(e => e.kind === 'stop-review');
    if (stops.length) lines.push(`stop reviews: ${stops.length}, blocked: ${stops.filter(e => e.blocked).length}`);
    const pushes = events.filter(e => e.kind === 'push');
    if (pushes.length) lines.push(`pushes: ${pushes.length}, blocked: ${pushes.filter(e => e.passed === false).length}`);
    const reviews = events.filter(e => e.kind === 'review');
    if (reviews.length) lines.push(`reviews: ${reviews.length}, last: ${String(reviews[reviews.length - 1].outcome)} with ${num(reviews[reviews.length - 1].blocking)} blocking${typeof reviews[reviews.length - 1].integrity === 'string' ? ` (record ${String(reviews[reviews.length - 1].integrity).slice(0, 16)})` : ''}`);
    lines.push('');
    for (const e of events) lines.push(`  ${e.at.slice(0, 19).replace('T', ' ')}  ${e.kind.padEnd(11)} ${describe(e)}`);
    return lines;
}

/** Files that had a finding at one edit check and none at a later one: caught while writing, fixed before push. */
function cleanedAfter(checks: ThreadEvent[]): number {
    const flagged = new Set<string>();
    const cleaned = new Set<string>();
    for (const e of checks) {
        const files = Array.isArray(e.files) ? (e.files as unknown[]).filter((f): f is string => typeof f === 'string') : [];
        if (num(e.findings) > 0) files.forEach(f => flagged.add(f));
        else files.filter(f => flagged.has(f)).forEach(f => cleaned.add(f));
    }
    return cleaned.size;
}

function describe(e: ThreadEvent): string {
    const who = [e.agent, e.session ? `session ${String(e.session).slice(0, 8)}` : undefined].filter(Boolean).join(', ');
    const files = Array.isArray(e.files) ? `${(e.files as unknown[]).length} file(s)` : '';
    const what = e.kind === 'edit-check' ? `${files}, ${num(e.findings)} finding(s)`
        : e.kind === 'stop-review' ? (e.blocked ? `blocked: ${num(e.blocking)} to fix` : 'passed')
            : e.kind === 'push' ? (e.passed === false ? `blocked: ${num(e.failed)} check(s) failed` : 'passed')
                : e.kind === 'review' ? `${String(e.outcome)}, ${num(e.blocking)} blocking, ${num(e.should_fix)} should-fix${e.pr ? ` on #${e.pr}` : ''}`
                    : e.kind === 'brief' ? `${num(e.items)} item(s) briefed` : '';
    return [what, who ? `(${who})` : '', e.head ? `@${String(e.head).slice(0, 9)}` : ''].filter(Boolean).join(' ');
}

function readEvents(file: string): ThreadEvent[] {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    return text.split('\n').filter(Boolean).flatMap(line => {
        try {
            const e = JSON.parse(line);
            return e && typeof e.at === 'string' && typeof e.task === 'string' && typeof e.kind === 'string' ? [e as ThreadEvent] : [];
        } catch {
            return [];
        }
    }).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Where the repository's threads are: its common git folder, so every worktree of it writes to the same threads. */
export function threadsDir(cwd: string): string | undefined {
    const common = git(cwd, ['rev-parse', '--git-common-dir']);
    return common ? path.join(path.resolve(cwd, common), THREADS_DIR) : undefined;
}

function listThreads(dir: string): string[] {
    try {
        return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    } catch {
        return [];
    }
}

/** A key as a file name: anything but letters, digits, dot, dash and underscore becomes `_`. */
function fileName(key: string): string {
    return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
}
