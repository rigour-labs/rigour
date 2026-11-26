/**
 * The throwaway copy a judge that runs code works in (run-code.ts, copy-pool.ts): `<tmp>/rigour-judge-copy-XXXXXX/repo`,
 * a standalone clone of the reviewed commit with no remote. `--local`: its objects are hardlinked, never an alternates
 * file, so no path in it leads back to the person's .git (and the sandboxes keep the judge from writing its .git).
 * Not a git worktree: a worktree resolves to the person's checkout, whose trust and settings a CLI would take. Beside
 * `repo`, outside what the judge may write, `owner.json` names the Rigour process that made it (pid, start time, user):
 * a copy is swept only once that process is gone, never because it is old.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GH_TIMEOUT_MS, type Exec } from './exec.js';
import { ownerState, thisProcess, type Owner } from './owner-process.js';
import { shareDependencies } from './throwaway-worktree.js';

const COPY_PREFIX = 'rigour-judge-copy-';
/** A review's own input folder (reviewer.ts): owned the same way, so a killed review's is swept too. */
const WORK_PREFIX = 'rigour-reviewer-';
const GIT_TIMEOUT_MS = 5 * GH_TIMEOUT_MS;

/** Every Rigour copy's path starts with this (the real temporary directory and the prefix). */
export function copyPrefix(): string {
    return path.join(fs.realpathSync(os.tmpdir()), COPY_PREFIX);
}

/**
 * `tmp`: the judge's own temporary base, `/tmp/rgr-XXXXXX`, removed with the copy. Short on purpose: Claude Code gives
 * the commands it runs `<CLAUDE_CODE_TMPDIR>/claude-<uid>` as their TMPDIR only when that path is about 30 bytes or
 * less (Unix socket paths), and falls back to the shared `/tmp/claude-<uid>` otherwise (a real run did).
 */
export interface Copy { root: string; dir: string; tmp: string }
interface FolderOwner extends Owner { uid: number; tmp?: string }

const JUDGE_TMP_PREFIX = '/tmp/rgr-';

/** The TMPDIR a judge's commands get in its temporary base: Claude Code's per-user folder there, made private. */
export const judgeTmpDir = (tmp: string) => path.join(tmp, `claude-${process.getuid?.() ?? 0}`);

/** A new, empty folder in the temporary directory, named `prefix…`, that names this process as its owner. */
function ownedDir(prefix: string, tmp: string, extra: { tmp?: string } = {}): string {
    const root = fs.mkdtempSync(path.join(tmp, prefix));
    const owner: FolderOwner = { ...thisProcess(), uid: process.getuid?.() ?? -1, ...extra };
    fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify(owner));
    return root;
}

/** The judge's temporary base, private (Claude Code uses it only then), with its TMPDIR inside. */
function newJudgeTmp(): string {
    const tmp = fs.mkdtempSync(JUDGE_TMP_PREFIX);
    try {
        // Its owner too, for a review that keeps its copies elsewhere (another TMPDIR): never swept while it runs.
        fs.writeFileSync(path.join(tmp, 'owner.json'), JSON.stringify({ ...thisProcess(), uid: process.getuid?.() ?? -1 }));
        fs.mkdirSync(judgeTmpDir(tmp), { mode: 0o700 });
    } catch (error) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw error;
    }
    return tmp;
}

/** A new, empty copy root owned by this process, its judge's temporary base named in its owner.json. */
function newRoot(): Copy {
    const tmp = newJudgeTmp();
    try {
        // The real path: what the system reports as a process's working directory in it (judge-processes.ts).
        const root = ownedDir(COPY_PREFIX, fs.realpathSync(os.tmpdir()), { tmp });
        return { root, dir: path.join(root, 'repo'), tmp };
    } catch (error) {
        removeJudgeTmp(tmp); // no root names it: nothing else would ever remove it
        throw error;
    }
}

/** A review's input folder, owned by this process: removed by the review, or by the sweep once the review is gone. */
export function reviewWorkDir(): string {
    return ownedDir(WORK_PREFIX, os.tmpdir());
}

/** Whether the repository at `dir` borrows objects through `objects/info/alternates`. */
function hasAlternates(dir: string): boolean {
    const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
    const file = common.status === 0 ? path.join(common.stdout.trim(), 'objects', 'info', 'alternates') : '';
    return !!file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '';
}

/** A copy of `head` (LFS files left as pointers: nothing is fetched), or why it could not be made. */
export async function makeCopy(cwd: string, head: string, exec: Exec): Promise<Copy | { error: string }> {
    const copy = newRoot();
    const git = (args: string[], at = copy.dir) => exec('git', args, { cwd: at, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
    const steps: Array<() => ReturnType<Exec>> = [
        // --dissociate: a repository that borrows objects (its own alternates) is copied whole, never borrowed from.
        () => git(['clone', '--quiet', '--local', ...(hasAlternates(cwd) ? ['--dissociate'] : []), '--no-checkout', cwd, copy.dir], copy.root),
        () => git(['checkout', '--quiet', '--detach', head]),
        () => git(['remote', 'remove', 'origin']),
    ];
    const fail = (why: string) => {
        removeCopy(copy);
        return { error: `could not make a throwaway copy of ${head.slice(0, 9)}: ${why}` };
    };
    for (const step of steps) {
        const done = await step();
        if (done.exitCode !== 0) return fail(done.stderr.trim() || `git exited ${done.exitCode}`);
    }
    if (hasAlternates(copy.dir)) return fail('it would borrow objects through an alternates file, which leads back to your repository');
    shareDependencies(cwd, copy.dir);
    return copy;
}

/**
 * The copy back at `head` with nothing the last judge wrote, or why not. Its node_modules is kept only while it is
 * still the link to the checkout's: one a judge replaced (a folder of its own, a link elsewhere) is removed and linked again.
 */
export async function resetCopy(cwd: string, copy: Copy, head: string, exec: Exec): Promise<string | undefined> {
    for (const args of [['checkout', '--quiet', '--force', '--detach', head], ['clean', '-ffdxq', '-e', '/node_modules']]) {
        const done = await exec('git', args, { cwd: copy.dir, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_LFS_SKIP_SMUDGE: '1' } });
        if (done.exitCode !== 0) return done.stderr.trim() || `git exited ${done.exitCode}`;
    }
    // The last judge's temporary files go too: a fixed-name folder (pytest's) starts empty for the next.
    fs.rmSync(judgeTmpDir(copy.tmp), { recursive: true, force: true });
    fs.mkdirSync(judgeTmpDir(copy.tmp), { mode: 0o700 });
    const link = path.join(copy.dir, 'node_modules');
    const theirs = path.join(cwd, 'node_modules');
    const now = fs.lstatSync(link, { throwIfNoEntry: false });
    const intact = fs.existsSync(theirs) ? !!now?.isSymbolicLink() && fs.readlinkSync(link) === theirs : !now;
    if (!intact) {
        fs.rmSync(link, { recursive: true, force: true });
        shareDependencies(cwd, copy.dir);
    }
    return undefined;
}

/** Removes the copy: its temporary base first, so a root that cannot be removed leaves no base only it names. */
export function removeCopy(copy: Copy): void {
    removeJudgeTmp(copy.tmp);
    fs.rmSync(copy.root, { recursive: true, force: true });
}

/** Whether `tmp` is one of Rigour's judge temporary bases (by its prefix) and this user's. */
function ourJudgeTmp(tmp: string | undefined): tmp is string {
    if (!tmp?.startsWith(JUDGE_TMP_PREFIX) || tmp.slice(JUDGE_TMP_PREFIX.length).includes('/')) return false;
    return fs.statSync(tmp, { throwIfNoEntry: false })?.uid === process.getuid?.();
}

/** Removes a judge's temporary base: only ever one of Rigour's, and only this user's. */
function removeJudgeTmp(tmp: string | undefined): void {
    if (ourJudgeTmp(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
}

/**
 * Removes judge temporary bases no copy names any more: this user's, private (0700, as Rigour makes them), named by no
 * copy root whose owner is not gone, and either their own owner is gone or, with no owner.json, an hour old (a crash
 * between making one and writing its owner).
 */
function sweepJudgeTmps(named: Set<string>): void {
    const base = path.dirname(JUDGE_TMP_PREFIX);
    for (const name of fs.readdirSync(base).filter(entry => entry.startsWith(path.basename(JUDGE_TMP_PREFIX)))) {
        const tmp = path.join(base, name);
        const stat = fs.statSync(tmp, { throwIfNoEntry: false });
        if (!stat || named.has(tmp) || !ourJudgeTmp(tmp) || (stat.mode & 0o777) !== 0o700) continue;
        const owner = ownerOf(tmp);
        if (owner ? owner.uid !== process.getuid?.() || ownerState(owner) !== 'gone' : Date.now() - stat.mtimeMs <= 3_600_000) continue;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Whether the process that made the copy at `root` is gone: its pid ended, or now another process's. */
function ownerOf(root: string): FolderOwner | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8')) as FolderOwner;
    } catch {
        return undefined;
    }
}

function orphaned(root: string): boolean {
    const owner = ownerOf(root);
    if (!owner) {
        // No owner: a copy made before owners were written, or one interrupted before it wrote its own (within a
        // millisecond of being made). Either way not a live review's once it is an hour old.
        return Date.now() - fs.statSync(root).mtimeMs > 3_600_000;
    }
    // Another user's copy is never this one's to judge, whatever its pid.
    if (owner.uid !== (process.getuid?.() ?? -1)) return false;
    return ownerState(owner) === 'gone';
}

/** Removes the copies and review folders whose Rigour process is gone, this user's only; returns them. */
export function sweepStaleCopies(): string[] {
    // Without ps no owner can be told from a later process with its pid: nothing is removed.
    if (!thisProcess().started) return [];
    const tmp = fs.realpathSync(os.tmpdir());
    const swept: string[] = [];
    const named = new Set<string>();
    for (const name of fs.readdirSync(tmp).filter(entry => entry.startsWith(COPY_PREFIX) || entry.startsWith(WORK_PREFIX))) {
        const root = path.join(tmp, name);
        try {
            if (fs.statSync(root).uid !== process.getuid?.() || !orphaned(root)) {
                const kept = ownerOf(root)?.tmp;
                if (kept) named.add(kept);
                continue;
            }
            removeJudgeTmp(ownerOf(root)?.tmp);
            fs.rmSync(root, { recursive: true, force: true });
            swept.push(root);
        } catch {
            // gone meanwhile, or not readable: not this user's to remove
        }
    }
    sweepJudgeTmps(named);
    return swept;
}
