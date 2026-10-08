/**
 * The engineering task: one piece of work, whatever agents and people touch it, and its thread, everything that
 * happened to it in order. Events are kept per branch, one file each (`<git dir>/rigour/threads/<branch>-<hash>.jsonl`,
 * the hash of the exact branch name, so no two branches share a file). The task is the ticket the branch names when
 * the branch's own commit subjects, or the title of its pull request as a review recorded it, write it as a ticket
 * (`PROJ-123`): a version token in a branch name (`pin-node-22`, `utf-8`) is not a ticket. Otherwise the task is the
 * branch. The task is worked out once per commit and kept: the edit hook runs on every edit. Reading a ticket gathers every branch that worked on it;
 * a pull request joins when a review of it runs. Writers only append, and never fail the hook or command they run in.
 * The files live in the repository's common git folder, shared by its worktrees; nothing enters the working tree.
 *
 * What a thread holds is what Rigour saw: hooked agent sessions (the edit check, the stop review), the push gate, and
 * reviews. Work done where no hook ran (an agent without hooks, a person in an editor) shows only through the commits
 * and reviews that follow it.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
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

/**
 * The task the checkout is working on: the ticket its branch names when one of the branch's own commit subjects names
 * it too, else the branch; undefined on a detached head.
 */
export function taskOf(cwd: string): { key: string; branch: string; head?: string } | undefined {
    const task = taskIn(cwd);
    return task ? { key: task.key, branch: task.branch, ...(task.head ? { head: task.head } : {}) } : undefined;
}

/** The task and the folder its thread is in, with one lookup of each: the edit hook pays for this on every edit. */
function taskIn(cwd: string): { key: string; branch: string; head?: string; dir?: string } | undefined {
    const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']); // a branch with no commit yet has a task too
    if (!branch) return undefined;
    const head = git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
    const dir = threadsDir(cwd);
    const cache = dir ? path.join(dir, '..', 'task-cache.json') : undefined;
    const cached = cache ? readJson(cache)[branch] : undefined;
    if (cached && cached.head === (head ?? '') && typeof cached.key === 'string') return { key: cached.key, branch, ...(head ? { head } : {}), ...(dir ? { dir } : {}) };
    const ticket = TICKET.exec(branch)?.[1]?.toUpperCase();
    // Written as a ticket (upper case, as trackers print it): `node-22` in a subject is a version, not a ticket.
    const written = ticket ? new RegExp(`(^|[^A-Za-z0-9])${ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`) : undefined;
    const titles = dir ? readEvents(path.join(dir, branchFile(branch))).map(e => e.pr_title).filter((t): t is string => typeof t === 'string') : [];
    const confirmed = !!written && [...titles, ...branchSubjects(cwd)].some(text => written.test(text));
    const key = confirmed ? ticket! : `branch:${branch}`;
    if (cache) writeCache(cache, branch, { head: head ?? '', key });
    return { key, branch, ...(head ? { head } : {}), ...(dir ? { dir } : {}) };
}

function readJson(file: string): Record<string, { head?: string; key?: string }> {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/** The task worked out for a branch at a commit; `undefined` forgets it (a new pull request title may confirm a ticket). */
function writeCache(file: string, branch: string, entry: { head: string; key: string } | undefined): void {
    try {
        const all = readJson(file);
        if (entry) all[branch] = entry;
        else delete all[branch];
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(all));
    } catch {
        // a cache that cannot be written is worked out again next time
    }
}

/** The subjects of the branch's own commits: since it left the main branch, or its last 50 when no main branch is found. */
function branchSubjects(cwd: string): string[] {
    const main = ['origin/main', 'main', 'origin/master', 'master'].find(ref => git(cwd, ['rev-parse', '--verify', '-q', ref]) !== undefined);
    const base = main ? git(cwd, ['merge-base', 'HEAD', main]) : undefined;
    const range = base && base !== git(cwd, ['rev-parse', 'HEAD']) ? [`${base}..HEAD`] : ['-50', 'HEAD'];
    return (git(cwd, ['log', '--format=%s', ...range]) ?? '').split('\n').filter(Boolean);
}

/** Appends one event to the checkout's task thread. Best effort: a thread never breaks the hook or command it runs in. */
export function appendTaskEvent(cwd: string, event: TaskEvent): ThreadEvent | undefined {
    try {
        const task = taskIn(cwd);
        if (!task?.dir) return undefined;
        const dir = task.dir;
        const line: ThreadEvent = { at: new Date().toISOString(), task: task.key, branch: task.branch, ...(task.head ? { head: task.head } : {}), ...event };
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, branchFile(task.branch)), JSON.stringify(line) + '\n');
        // A pull request title can confirm the branch's ticket: work the task out again next time.
        if (typeof event.pr_title === 'string' && task.key.startsWith('branch:')) writeCache(path.join(dir, '..', 'task-cache.json'), task.branch, undefined);
        return line;
    } catch {
        return undefined;
    }
}

/**
 * The thread for a key, oldest first: a ticket (`PROJ-123`, every branch whose events carry it, from their first
 * event), a branch name, a pull request (`#42` or `42`: the branches a review of it ran on), or nothing for the
 * checkout's own task. Matching is on the keys stored in the events, never on file names. Unreadable lines are skipped.
 */
export function readThread(cwd: string, key?: string): { task: string; events: ThreadEvent[] } | undefined {
    const dir = threadsDir(cwd);
    if (!dir) return undefined;
    const wanted = key?.trim();
    if (!wanted) {
        const own = taskOf(cwd);
        if (!own) return undefined;
        return own.key.startsWith('branch:') ? { task: own.key, events: readEvents(path.join(dir, branchFile(own.branch))).filter(e => e.branch === own.branch) } : byTask(dir, own.key) ?? { task: own.key, events: [] };
    }
    const pr = /^#?(\d+)$/.exec(wanted)?.[1];
    if (pr) {
        const found = gather(dir, `#${pr}`, events => events.some(e => e.pr === Number(pr)));
        return found ? { task: found.events[found.events.length - 1].task, events: found.events } : undefined;
    }
    const branch = wanted.replace(/^branch:/, '');
    const own = readEvents(path.join(dir, branchFile(branch))).filter(e => e.branch === branch);
    if (own.length) return { task: own[own.length - 1].task, events: own };
    return byTask(dir, wanted.toUpperCase());
}

/** Every branch whose events name the task, whole, as one thread. */
function byTask(dir: string, task: string): { task: string; events: ThreadEvent[] } | undefined {
    return gather(dir, task, events => events.some(e => e.task === task));
}

function gather(dir: string, task: string, wanted: (events: ThreadEvent[]) => boolean): { task: string; events: ThreadEvent[] } | undefined {
    const events = listThreads(dir).map(file => readEvents(path.join(dir, file))).filter(wanted).flat().sort(byTime);
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
    }).sort(byTime);
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

/** A branch's thread file: a readable form of its name, and a hash of the exact name, so `a/b` and `a_b` never share one. */
function branchFile(branch: string): string {
    return `${branch.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-${createHash('sha1').update(branch).digest('hex').slice(0, 8)}.jsonl`;
}

function byTime(a: ThreadEvent, b: ThreadEvent): number {
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

function num(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function git(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
    return result.status === 0 ? result.stdout.trim() : undefined;
}
