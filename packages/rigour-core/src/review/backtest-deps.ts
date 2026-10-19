/**
 * A backtest round's dependencies, as of its commit: the typed checks type-check the commit against what is installed,
 * so today's packages would judge yesterday's code. When the commit's lockfile is byte for byte this checkout's, the
 * checkout's node_modules is the commit's and is shared. Otherwise the commit's own lockfile is installed (frozen, no
 * scripts, none of the commit's code run: backtest-install.ts) into a cache in the user's cache directory, outside every
 * project (a package manager looks upward for a workspace and settings), keyed by what the install reads, reused by every round that reads the same and bounded to the few used last. Only when that cannot be
 * done, or `--share-deps` asks, does a round run on today's dependencies, and its report says so.
 */
import fs from 'fs';
import path from 'path';
import type { Exec } from './reviewer.js';
import { rigourCacheDir } from '../utils/user-state.js';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { LOCKFILES, OWN_YARN, planInstall, planKey, runInstall, type Manager, type SettingsLeftOut } from './backtest-install.js';

/** Which dependencies a round ran with. */
export interface DependencyUse {
    /** `same-lockfile`: this checkout's, the commit's lockfile being identical; `commit`: installed from its lockfile; `today`: this checkout's though the commit's differ; `none`: nothing to link. */
    used: 'same-lockfile' | 'commit' | 'today' | 'none';
    /** Why, for `today` and `none`; the cache's key for `commit`. */
    detail?: string;
    /** Settings the install left out of the commit's package-manager configs, by key name (backtest-install-config.ts). */
    settingsLeftOut?: SettingsLeftOut[];
}

export interface DependencyOptions {
    share?: boolean;
    exec: Exec;
    keep?: number;
    /** Install with your whole environment, registry credentials included (`--deps-env`). */
    fullEnv?: boolean;
}

const KEEP = 3;
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
    // With nothing to share, the reason the round could not use the commit's own still shows.
    const shared = (use: DependencyUse) => (fs.existsSync(today)
        ? { use, target: today }
        : { use: { used: 'none' as const, detail: `this checkout has no node_modules to share${use.detail ? ` (${use.detail})` : ''}` } });
    if (!fs.existsSync(path.join(worktree, 'package.json'))) return { use: { used: 'none', detail: 'the commit has no package.json' } };
    const theirs = lockfiles(worktree);
    if (theirs.length === 0) return shared({ used: 'today', detail: 'the commit has no lockfile to install from' });
    if (sameLockfiles(theirs, lockfiles(cwd))) return shared({ used: 'same-lockfile' });
    if (options.share) return shared({ used: 'today', detail: '--share-deps' });
    const installed = await fromCache(cwd, worktree, theirs[0].manager, options);
    const leftOut = installed.settingsLeftOut?.length ? { settingsLeftOut: installed.settingsLeftOut } : {};
    if ('error' in installed) return shared({ used: 'today', detail: installed.error, ...leftOut });
    return { use: { used: 'commit', detail: installed.key, ...leftOut }, target: installed.modules };
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

/** The commit's dependencies installed in the cache, reused when they already are; why not, when they cannot be. */
async function fromCache(cwd: string, worktree: string, manager: Manager, options: DependencyOptions): Promise<({ key: string; modules: string } | { error: string }) & { settingsLeftOut?: SettingsLeftOut[] }> {
    const cache = depsCache(cwd);
    let dir: string | undefined;
    let settingsLeftOut: SettingsLeftOut[] | undefined;
    try {
        const plan = await planInstall(worktree, manager, options.exec, !!options.fullEnv);
        if (typeof plan === 'string') return { error: `reading the commit's install inputs failed: ${plan}` };
        settingsLeftOut = plan.settingsLeftOut;
        if (plan.ownYarn) return { error: OWN_YARN, settingsLeftOut };
        if (plan.unsafe) return { error: plan.unsafe, settingsLeftOut };
        const above = projectAbove(cache);
        if (above) return { error: `the dependency cache ${cache} sits under ${above}, which the package manager would read as a project of its own; set RIGOUR_HOME to a folder outside any project`, settingsLeftOut };
        const key = planKey(plan);
        dir = path.join(cache, key);
        if (!fs.existsSync(path.join(dir, READY))) {
            fs.rmSync(dir, { recursive: true, force: true });
            const error = await runInstall(plan, dir, options.exec, !!options.fullEnv);
            if (error) throw new Error(error);
        }
        fs.writeFileSync(path.join(dir, READY), new Date().toISOString());
        bound(cache, key, options.keep ?? KEEP);
        return { key, modules: path.join(dir, 'node_modules'), settingsLeftOut };
    } catch (error) {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        return { error: `installing the commit's lockfile failed: ${error instanceof Error ? error.message : String(error)}`, settingsLeftOut };
    }
}

/** This repository's installs, in the user's cache directory (RIGOUR_HOME's when set): never inside a checkout. */
function depsCache(cwd: string): string {
    return path.join(rigourCacheDir(), 'backtest-deps', repositoryIdSync(cwd).slice(0, 16));
}

/** What a package manager would take for a project above the cache: a manifest, a pnpm workspace or yarn settings. */
const PROJECT_FILES = ['package.json', 'pnpm-workspace.yaml', '.yarnrc.yml', '.yarnrc'];

/**
 * The first project file above the cache, on the path as written and on its real path: a RIGOUR_HOME that is a
 * symlink into a repository is where the install would really land.
 */
function projectAbove(dir: string): string | undefined {
    fs.mkdirSync(dir, { recursive: true });
    for (const start of new Set([path.resolve(dir), fs.realpathSync(dir)])) {
        const found = projectAboveFrom(start);
        if (found) return found;
    }
    return undefined;
}

function projectAboveFrom(dir: string): string | undefined {
    for (let at = path.dirname(dir); ; at = path.dirname(at)) {
        const found = PROJECT_FILES.map(name => path.join(at, name)).find(file => fs.existsSync(file));
        if (found) return found;
        if (path.dirname(at) === at) return undefined;
    }
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
