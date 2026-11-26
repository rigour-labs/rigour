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

export interface Copy { root: string; dir: string }
interface FolderOwner extends Owner { uid: number }

/** A new, empty folder in the temporary directory, named `prefix…`, that names this process as its owner. */
function ownedDir(prefix: string, tmp: string): string {
    const root = fs.mkdtempSync(path.join(tmp, prefix));
    const owner: FolderOwner = { ...thisProcess(), uid: process.getuid?.() ?? -1 };
    fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify(owner));
    return root;
}

/** A new, empty copy root owned by this process. */
function newRoot(): Copy {
    // The real path: what the system reports as a process's working directory in it (judge-processes.ts).
    const root = ownedDir(COPY_PREFIX, fs.realpathSync(os.tmpdir()));
    return { root, dir: path.join(root, 'repo') };
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

export function removeCopy(copy: Copy): void {
    fs.rmSync(copy.root, { recursive: true, force: true });
}

/** Whether the process that made the copy at `root` is gone: its pid ended, or now another process's. */
function orphaned(root: string): boolean {
    let owner: FolderOwner;
    try {
        owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8')) as FolderOwner;
    } catch {
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
    for (const name of fs.readdirSync(tmp).filter(entry => entry.startsWith(COPY_PREFIX) || entry.startsWith(WORK_PREFIX))) {
        const root = path.join(tmp, name);
        try {
            if (fs.statSync(root).uid !== process.getuid?.() || !orphaned(root)) continue;
            fs.rmSync(root, { recursive: true, force: true });
            swept.push(root);
        } catch {
            // gone meanwhile, or not readable: not this user's to remove
        }
    }
    return swept;
}
