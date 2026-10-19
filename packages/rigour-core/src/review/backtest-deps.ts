/**
 * A backtest round's dependencies, as of its commit: the typed checks type-check the commit against what is installed,
 * so today's packages would judge yesterday's code. When the commit's lockfile is byte for byte this checkout's, the
 * checkout's node_modules is the commit's and is shared. Otherwise the commit's own lockfile is installed, frozen,
 * offline first and with no scripts, into a cache under the git directory keyed by the lockfile's hash, reused by every
 * round with the same lockfile and bounded to the few used last. Only when that cannot be done, or `--share-deps` asks,
 * does a round run on today's dependencies, and its report says so.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Exec } from './reviewer.js';

/** Which dependencies a round ran with. */
export interface DependencyUse {
    /** `same-lockfile`: this checkout's, the commit's lockfile being identical; `commit`: installed from its lockfile; `today`: this checkout's though the commit's differ; `none`: nothing to link. */
    used: 'same-lockfile' | 'commit' | 'today' | 'none';
    /** Why, for `today` and `none`; the cache's key for `commit`. */
    detail?: string;
}

export interface DependencyOptions { share?: boolean; exec: Exec; keep?: number }

/** Lockfiles by the package manager that reads them, in the order a project with several is installed by. */
const LOCKFILES: Array<[string, Manager]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']];
type Manager = 'pnpm' | 'yarn' | 'npm' | 'bun';
/** What an install of the commit's lockfile reads besides the lockfile: its manifests, workspace and registry settings, patches. */
const INSTALL_INPUTS = /(^|\/)(package\.json|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|bunfig\.toml)$|^(patches|\.yarn\/(releases|plugins|patches))\//;
const KEEP = 3;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const READY = '.rigour-ready';

/** Links the round's dependencies into the worktree and says which they are. */
export async function linkDependencies(cwd: string, worktree: string, options: DependencyOptions): Promise<DependencyUse> {
    const link = path.join(worktree, 'node_modules');
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink()) return { used: 'none', detail: 'the backtest checkout has a node_modules of its own, left as it is' };
    const choice = await chooseDependencies(cwd, worktree, options);
    if (stat) fs.unlinkSync(link);
    if (choice.target) fs.symlinkSync(choice.target, link, 'junction');
    return choice.use;
}

async function chooseDependencies(cwd: string, worktree: string, options: DependencyOptions): Promise<{ use: DependencyUse; target?: string }> {
    const today = path.join(cwd, 'node_modules');
    const shared = (use: DependencyUse) => (fs.existsSync(today) ? { use, target: today } : { use: { used: 'none' as const, detail: 'this checkout has no node_modules to share' } });
    if (!fs.existsSync(path.join(worktree, 'package.json'))) return { use: { used: 'none', detail: 'the commit has no package.json' } };
    const theirs = lockfiles(worktree);
    if (theirs.length === 0) return shared({ used: 'today', detail: 'the commit has no lockfile to install from' });
    if (sameLockfiles(theirs, lockfiles(cwd))) return shared({ used: 'same-lockfile' });
    if (options.share) return shared({ used: 'today', detail: '--share-deps' });
    const installed = await fromCache(worktree, theirs, options);
    if ('error' in installed) return shared({ used: 'today', detail: installed.error });
    return { use: { used: 'commit', detail: installed.key }, target: installed.modules };
}

interface Lockfile { name: string; manager: Manager; bytes: Buffer }

function lockfiles(dir: string): Lockfile[] {
    return LOCKFILES.flatMap(([name, manager]) => {
        try {
            return [{ name, manager, bytes: fs.readFileSync(path.join(dir, name)) }];
        } catch {
            return [];
        }
    });
}

function sameLockfiles(a: Lockfile[], b: Lockfile[]): boolean {
    return a.length === b.length && a.every((lock, i) => lock.name === b[i].name && lock.bytes.equals(b[i].bytes));
}

/** The commit's lockfile installed in the cache, reused when it already is; an error when it cannot be. */
async function fromCache(worktree: string, locks: Lockfile[], options: DependencyOptions): Promise<{ key: string; modules: string } | { error: string }> {
    const hash = createHash('sha256');
    for (const lock of locks) hash.update(lock.name).update('\0').update(lock.bytes).update('\0');
    const key = hash.digest('hex').slice(0, 16);
    const cache = path.join(path.dirname(worktree), 'deps');
    const dir = path.join(cache, key);
    if (!fs.existsSync(path.join(dir, READY))) {
        fs.rmSync(dir, { recursive: true, force: true });
        const error = await install(worktree, dir, locks[0].manager, options.exec);
        if (error) {
            fs.rmSync(dir, { recursive: true, force: true });
            return { error: `installing the commit's lockfile failed: ${error}` };
        }
    }
    fs.writeFileSync(path.join(dir, READY), new Date().toISOString());
    bound(cache, key, options.keep ?? KEEP);
    return { key, modules: path.join(dir, 'node_modules') };
}

/** Copies what the install reads from the commit into `dir` and installs there; the error, or undefined. */
async function install(worktree: string, dir: string, manager: Manager, exec: Exec): Promise<string | undefined> {
    const listed = await exec('git', ['ls-files', '-z'], { cwd: worktree, timeoutMs: 60_000 });
    if (listed.exitCode !== 0) return listed.stderr.trim() || 'git ls-files failed';
    const inputs = listed.stdout.split('\0').filter(file => INSTALL_INPUTS.test(file) && !file.split('/').includes('node_modules'));
    for (const file of [...inputs, ...LOCKFILES.map(([name]) => name).filter(name => fs.existsSync(path.join(worktree, name)))]) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.copyFileSync(path.join(worktree, file), path.join(dir, file));
    }
    const [command, args] = installCommand(manager, fs.existsSync(path.join(dir, '.yarnrc.yml')));
    const ran = await exec(command, args, { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS, env: { CI: 'true' } });
    if (ran.exitCode !== 0) return `${command} ${args.join(' ')}: ${(ran.stderr || ran.stdout).trim().split('\n').at(-1) ?? `exit ${ran.exitCode}`}`;
    return fs.existsSync(path.join(dir, 'node_modules')) ? undefined : `${command} installed no node_modules`;
}

/** Frozen to the lockfile, offline first, no lifecycle scripts: nothing the commit's packages run, nothing re-resolved. */
function installCommand(manager: Manager, yarnBerry: boolean): [string, string[]] {
    if (manager === 'pnpm') return ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts']];
    if (manager === 'yarn') return yarnBerry ? ['yarn', ['install', '--immutable', '--mode=skip-build']] : ['yarn', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--non-interactive']];
    if (manager === 'bun') return ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']];
    return ['npm', ['ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund']];
}

/** Keeps the `keep` installs used last, this round's first, and deletes the rest: each is a whole node_modules. */
function bound(cache: string, current: string, keep: number): void {
    const used = (name: string) => (name === current ? Infinity : fs.statSync(path.join(cache, name, READY), { throwIfNoEntry: false })?.mtimeMs ?? 0);
    const dirs = fs.readdirSync(cache).sort((a, b) => used(b) - used(a));
    for (const name of dirs.slice(keep)) fs.rmSync(path.join(cache, name), { recursive: true, force: true });
}

/** The report's words for a round's dependencies. */
export function describeDependencies(use: DependencyUse): string {
    if (use.used === 'same-lockfile') return "the commit's (its lockfile is this checkout's, so this checkout's node_modules is shared)";
    if (use.used === 'commit') return `the commit's, installed from its lockfile (cache ${use.detail})`;
    if (use.used === 'today') return `today's, not the commit's (${use.detail})`;
    return `none (${use.detail})`;
}
