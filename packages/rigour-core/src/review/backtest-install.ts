/**
 * Installing a commit's own dependencies for a backtest round without running the commit's code. Only data is taken
 * from the commit: its lockfiles, manifests, workspace and registry settings, and patches. Nothing executable is:
 * no `.pnpmfile.cjs` (and pnpm runs with `--ignore-pnpmfile`), no `.yarn/plugins` or `.yarn/releases`, and every
 * package-manager settings file is cut to an allowlist of registry, trust and sign-in keys (backtest-install-config.ts);
 * a commit that installs with its own yarn release is not installed at all. Lifecycle scripts are off. A symlink whose target leaves the commit's checkout is skipped.
 *
 * The package manager runs with a minimal environment: PATH, a scratch HOME (so your own `~/.npmrc` and its tokens are
 * not read), the proxy and certificate variables, and nothing else, so a `${NPM_TOKEN}` in the commit's `.npmrc` gets
 * nothing. `--deps-env` passes the whole environment instead, and with it your registry credentials.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Exec } from './reviewer.js';
import { allowedSettings } from './backtest-install-config.js';

export type Manager = 'pnpm' | 'yarn' | 'npm' | 'bun';

/** Lockfiles by the package manager that reads them, in the order a project with several is installed by. */
export const LOCKFILES: Array<[string, Manager]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']];
/** What an install reads besides the lockfile, all of it data: manifests, workspace and registry settings, patches. */
const INPUTS = /(^|\/)(package\.json|pnpm-workspace\.yaml|\.npmrc|\.yarnrc(\.yml)?|bunfig\.toml)$|^(patches|\.yarn\/patches)\//;
/** What a package manager would run from the commit: never copied. */
const EXECUTABLE = /(^|\/)\.pnpmfile\.cjs$|^\.yarn\/(plugins|releases)\//;
/** A line naming the yarn binary to run from the repository. */
const YARN_PATH = /^\s*(yarnPath|yarn-path)\b.*$/m;
/** The only variables the install inherits: where programs are, how to reach the registry through a proxy, which CAs to trust. */
const INHERITED = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'npm_config_cafile', 'NPM_CONFIG_CAFILE'];
const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** Why a commit is not installed when it brings its own yarn. */
export const OWN_YARN = 'this commit installs with its own yarn release, which Rigour does not run';

export interface InstallFile { rel: string; bytes: Buffer }

/** One copied config's keys left out, by name. */
export interface SettingsLeftOut { file: string; keys: string[] }

export interface InstallPlan {
    manager: Manager;
    files: InstallFile[];
    /** Executable inputs the commit has that were not copied: named when the install then fails. */
    leftOut: string[];
    /** The install would run the repository's own yarn: not run. */
    ownYarn: boolean;
    /** The commit carries registry settings: a failure may be a private registry, which needs `--deps-env`. */
    registrySettings: boolean;
    /** Settings left out of each copied config, by key name (never a value). */
    settingsLeftOut: SettingsLeftOut[];
}

/** What to install from the commit's checkout, read without following a link out of it. */
export async function planInstall(worktree: string, manager: Manager, exec: Exec): Promise<InstallPlan | string> {
    const listed = await exec('git', ['ls-files', '-z'], { cwd: worktree, timeoutMs: 60_000 });
    if (listed.exitCode !== 0) return listed.stderr.trim() || 'git ls-files failed';
    const tracked = listed.stdout.split('\0').filter(file => file && !file.split('/').includes('node_modules'));
    const root = fs.realpathSync(worktree);
    const files: InstallFile[] = [];
    const settingsLeftOut: SettingsLeftOut[] = [];
    for (const rel of tracked.filter(file => INPUTS.test(file) || LOCKFILES.some(([name]) => name === file))) {
        const bytes = readInside(root, rel);
        if (!bytes) continue;
        const allowed = allowedSettings(rel, bytes.toString('utf8'));
        if (allowed?.dropped.length) settingsLeftOut.push({ file: rel, keys: [...new Set(allowed.dropped)] });
        files.push({ rel, bytes: allowed ? Buffer.from(allowed.text) : bytes });
    }
    const yarnrc = files.find(f => f.rel === '.yarnrc.yml');
    const ownYarn = manager === 'yarn' && !!yarnrc && (tracked.some(file => /^\.yarn\/releases\//.test(file)) || YARN_PATH.test(readInside(root, '.yarnrc.yml')?.toString('utf8') ?? ''));
    return { manager, files, leftOut: tracked.filter(file => EXECUTABLE.test(file)), ownYarn, registrySettings: files.some(f => /(^|\/)\.(npmrc|yarnrc(\.yml)?)$/.test(f.rel)), settingsLeftOut };
}

/** The file's bytes, or undefined when it is a link leading out of the checkout or to nothing. */
function readInside(root: string, rel: string): Buffer | undefined {
    try {
        const real = fs.realpathSync(path.join(root, rel));
        if (real !== root && !real.startsWith(root + path.sep)) return undefined;
        return fs.readFileSync(real);
    } catch {
        return undefined;
    }
}

/** The cache key: the lockfiles and every input copied, so a changed patch or .npmrc is a different install. */
export function planKey(plan: InstallPlan): string {
    const hash = createHash('sha256');
    for (const file of [...plan.files].sort((a, b) => a.rel.localeCompare(b.rel))) hash.update(file.rel).update('\0').update(file.bytes).update('\0');
    return hash.digest('hex').slice(0, 16);
}

/** Writes the plan's files into `dir` and installs there; the error, or undefined. */
export async function runInstall(plan: InstallPlan, dir: string, exec: Exec, fullEnv: boolean): Promise<string | undefined> {
    for (const file of plan.files) {
        fs.mkdirSync(path.dirname(path.join(dir, file.rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, file.rel), file.bytes);
    }
    const home = path.join(dir, '.rigour-home');
    fs.mkdirSync(home, { recursive: true });
    const [command, args] = installCommand(plan.manager, plan.files.some(f => f.rel === '.yarnrc.yml'));
    try {
        const ran = await exec(command, args, { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS, ...installEnv(home, fullEnv) });
        if (ran.exitCode !== 0) return failure(plan, `${command} ${args.join(' ')}: ${(ran.stderr || ran.stdout).trim().split('\n').at(-1) ?? `exit ${ran.exitCode}`}`, fullEnv);
        return fs.existsSync(path.join(dir, 'node_modules')) ? undefined : `${command} installed no node_modules`;
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

/** A failed install's reason, with what Rigour left out and how to let a private registry in. */
function failure(plan: InstallPlan, reason: string, fullEnv: boolean): string {
    const parts = [reason];
    if (plan.leftOut.length) parts.push(`the commit's ${plan.leftOut.join(', ')} ${plan.leftOut.length === 1 ? 'was' : 'were'} left out, as Rigour does not run repository code during an install`);
    if (plan.registrySettings && !fullEnv) parts.push('if it installs from a private registry, --deps-env passes your environment, and with it your registry credentials');
    return parts.join('; ');
}

/** Frozen to the lockfile, offline first where the manager can be, no lifecycle scripts, no pnpmfile. */
function installCommand(manager: Manager, yarnBerry: boolean): [string, string[]] {
    if (manager === 'pnpm') return ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile']];
    if (manager === 'yarn') return yarnBerry ? ['yarn', ['install', '--immutable', '--mode=skip-build']] : ['yarn', ['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--non-interactive']];
    if (manager === 'bun') return ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']];
    return ['npm', ['ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund']];
}

/** The install's environment: the inherited few and a scratch HOME, or (`--deps-env`) everything. */
function installEnv(home: string, fullEnv: boolean, env: NodeJS.ProcessEnv = process.env): { env: Record<string, string>; unset?: string[] } {
    const own = { CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
    if (fullEnv) return { env: own };
    const kept = Object.fromEntries(INHERITED.filter(name => env[name] !== undefined).map(name => [name, env[name] as string]));
    const set = { ...kept, ...own, HOME: home, USERPROFILE: home };
    return { env: set, unset: Object.keys(env).filter(name => !(name in set)) };
}
