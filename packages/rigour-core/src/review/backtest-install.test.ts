import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { defaultExec, type Exec } from './reviewer/exec.js';
import { formatBacktest, runBacktest, type BacktestOptions, type Ledger, type RoundResult } from './backtest.js';

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

describe('installing a commit\'s dependencies runs none of the commit\'s code', () => {
    let repo: string;
    let home: string;
    const savedHome = process.env.RIGOUR_HOME;
    /** This repository's dependency cache, under the test's own RIGOUR_HOME. */
    const cache = () => path.join(home, '.rigour', 'cache', 'backtest-deps', repositoryIdSync(repo).slice(0, 16));
    let installs: Array<{ command: string; args: string[]; files: string[]; env?: Record<string, string>; unset?: string[]; npmrc?: string; yarnrc?: string; read: (rel: string) => string | undefined }>;
    let fail: string | undefined;
    let last: RoundResult | undefined;
    let rounds = 0;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };
    const listFiles = (dir: string, prefix = ''): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
    // The package manager is stubbed: it records what it was given, and installs or fails as told.
    const exec: Exec = async (command, args, options) => {
        if (!MANAGERS.has(command)) return defaultExec(command, args, options);
        const read = (name: string) => (fs.existsSync(path.join(options.cwd, name)) ? fs.readFileSync(path.join(options.cwd, name), 'utf8') : undefined);
        const copied = Object.fromEntries(listFiles(options.cwd).map(rel => [rel, read(rel)]));
        installs.push({ command, args, files: Object.keys(copied).sort(), env: options.env, unset: options.unset, npmrc: read('.npmrc'), yarnrc: read('.yarnrc'), read: rel => copied[rel] });
        honourNpmrc(read('.npmrc'));
        if (fail === 'throw') throw new Error('the package manager could not start');
        if (fail) return { exitCode: 1, stdout: '', stderr: fail };
        fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    /** As npm does when it prepares a git dependency: a child process with node-options as NODE_OPTIONS, and the configured git. */
    const honourNpmrc = (npmrc: string | undefined) => {
        const setting = (key: string) => new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(npmrc ?? '')?.[1].trim();
        const nodeOptions = setting('node-options');
        if (nodeOptions) execFileSync(process.execPath, ['-e', ''], { env: { ...process.env, NODE_OPTIONS: nodeOptions } });
        const gitBinary = setting('git');
        if (gitBinary) execFileSync(process.execPath, [gitBinary]);
    };
    /** A commit on its own branch with these files, run as one round. */
    const round = async (files: Record<string, string>, options: Partial<BacktestOptions> = {}, links: Record<string, string> = {}) => {
        git('checkout', '-q', '-B', `round-${++rounds}`, 'main');
        for (const [rel, body] of Object.entries(files)) write(rel, body);
        for (const [rel, target] of Object.entries(links)) fs.symlinkSync(target, path.join(repo, rel));
        git('add', '-A');
        git('commit', '-qm', 'round');
        const commit = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
        const ledger: Ledger = { rounds: [{ id: 'r1', commit, base: commit, points: [], must_not_flag: [] }] };
        const results = await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { exec, ...options, progress: () => undefined, collect: async () => ({ items: [] }) });
        last = results[0];
        return results[0].replay!.dependencies;
    };

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-home-'));
        process.env.RIGOUR_HOME = home;
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-install-'));
        installs = [];
        fail = undefined;
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('.gitignore', 'node_modules\n');
        write('package.json', '{ "name": "example-shop", "private": true }\n');
        git('add', '-A');
        git('commit', '-qm', 'base');
        write('node_modules/today-marker', '');
    });
    afterEach(() => {
        if (savedHome === undefined) delete process.env.RIGOUR_HOME;
        else process.env.RIGOUR_HOME = savedHome;
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        try { git('worktree', 'prune'); } catch { /* the repository may be gone */ }
        fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('never copies a pnpmfile, and tells pnpm to ignore one', async () => {
        const used = await round({ 'pnpm-lock.yaml': 'lock 1', '.pnpmfile.cjs': 'require("child_process").execSync("touch owned")', 'pnpm-workspace.yaml': 'packages: []\n' });
        expect(used.used).toBe('commit');
        expect(installs[0].command).toBe('pnpm');
        expect(installs[0].args).toEqual(['install', '--frozen-lockfile', '--prefer-offline', '--ignore-scripts', '--ignore-pnpmfile']);
        expect(installs[0].files).toEqual(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
    }, 60_000);

    it('falls back with what it left out when the frozen install fails without it', async () => {
        fail = 'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH the pnpmfile checksum does not match';
        const used = await round({ 'pnpm-lock.yaml': 'lock 2', '.pnpmfile.cjs': 'module.exports = {}' });
        expect(used.used).toBe('today');
        expect(used.detail).toContain('ERR_PNPM_LOCKFILE_CONFIG_MISMATCH');
        expect(used.detail).toContain("the commit's .pnpmfile.cjs was left out, as Rigour does not run repository code during an install");
    }, 60_000);

    it('does not run a commit that brings its own yarn release, and strips yarn-path from a classic one', async () => {
        const berry = await round({ 'yarn.lock': 'lock 3', '.yarnrc.yml': 'yarnPath: .yarn/releases/yarn-4.0.0.cjs\nnodeLinker: node-modules\n', '.yarn/releases/yarn-4.0.0.cjs': 'process.exit(0)', '.yarn/plugins/plugin.cjs': 'x' });
        expect(berry).toEqual({ used: 'today', detail: 'this commit installs with its own yarn release, which Rigour does not run', settingsLeftOut: [{ file: '.yarnrc.yml', keys: ['yarnPath'] }] });
        expect(installs).toEqual([]); // nothing ran
        const classic = await round({ 'yarn.lock': 'lock 4', '.yarnrc': 'yarn-path "./tools/yarn.js"\nregistry "https://registry.example.com"\n' });
        expect(classic.used).toBe('commit');
        expect(installs[0].yarnrc).toBe('registry "https://registry.example.com"\n');
        expect(classic.settingsLeftOut).toEqual([{ file: '.yarnrc', keys: ['yarn-path'] }]);
    }, 60_000);

    it('installs with a minimal environment and a scratch HOME, unless --deps-env asks for everything', async () => {
        const vars = { EXAMPLE_REGISTRY_TOKEN: 'not-a-real-token', HTTPS_PROXY: 'http://proxy.example.com:3128', NODE_EXTRA_CA_CERTS: '/etc/example-ca.pem' };
        const before = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
        Object.assign(process.env, vars);
        try {
            await round({ 'package-lock.json': 'lock 5', '.npmrc': '//registry.example.com/:_authToken=${EXAMPLE_REGISTRY_TOKEN}\n' });
            const minimal = installs[0];
            expect(minimal.unset).toContain('EXAMPLE_REGISTRY_TOKEN');
            expect(minimal.env?.EXAMPLE_REGISTRY_TOKEN).toBeUndefined();
            expect(minimal.env?.HOME).toBe(path.join(cache(), path.basename(path.dirname(minimal.env!.HOME)), '.rigour-home'));
            expect(minimal.env?.PATH).toBe(process.env.PATH);
            expect([minimal.env?.HTTPS_PROXY, minimal.env?.NODE_EXTRA_CA_CERTS]).toEqual([vars.HTTPS_PROXY, vars.NODE_EXTRA_CA_CERTS]);
            expect(minimal.unset).not.toContain('HTTPS_PROXY');
            await round({ 'package-lock.json': 'lock 6', '.npmrc': 'registry=https://registry.example.com/\n' }, { depsEnv: true });
            expect(installs[1].unset).toBeUndefined();
            expect(installs[1].env).toEqual({ CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' });
        } finally {
            for (const [name, value] of Object.entries(before)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        }
    }, 60_000);

    it('keys the cache on what the install reads, not only the lockfile', async () => {
        await round({ 'package-lock.json': 'same lock', '.npmrc': 'registry=https://one.example.com/\n' });
        await round({ 'package-lock.json': 'same lock', '.npmrc': 'registry=https://two.example.com/\n' });
        await round({ 'package-lock.json': 'same lock', '.npmrc': 'registry=https://two.example.com/\n' });
        expect(installs.map(i => i.npmrc)).toEqual(['registry=https://one.example.com/\n', 'registry=https://two.example.com/\n']);
    }, 60_000);

    it('skips a link out of the checkout or to nothing, and falls back when the install itself throws', async () => {
        const outside = path.join(repo, '..', `${path.basename(repo)}-outside.npmrc`);
        fs.writeFileSync(outside, '//registry.example.com/:_authToken=outside-secret\n');
        try {
            const used = await round({ 'package-lock.json': 'lock 7', 'packages/a/package.json': '{}' }, {}, { '.npmrc': outside, 'packages/a/.npmrc': '../missing.npmrc' });
            expect(used.used).toBe('commit');
            expect(installs[0].npmrc).toBeUndefined();
            expect(installs[0].files).not.toContain('packages/a/.npmrc');
        } finally {
            fs.rmSync(outside, { force: true });
        }
        fail = 'throw';
        const thrown = await round({ 'package-lock.json': 'lock 8' });
        expect(thrown).toEqual({ used: 'today', detail: "installing the commit's lockfile failed: the package manager could not start" });
        expect(fs.readdirSync(cache())).toHaveLength(1); // nothing of the failed one is kept
    }, 60_000);

    it('keeps only allowlisted settings, so npm\'s node-options and git never run repository code while it prepares a git dependency', async () => {
        const marker = path.join(repo, '..', `${path.basename(repo)}-ran`);
        const checkout = path.join(repo, '.git', 'rigour-backtest', 'checkout'); // where the commit's code lands: predictable
        const payload = `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`;
        const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'example-tool': 'git+ssh://git@example.com/example-org/example-tool.git' } }, 'node_modules/example-tool': { resolved: 'git+ssh://git@example.com/example-org/example-tool.git#0123456789abcdef0123456789abcdef01234567' } } });
        const npmrc = [
            `node-options=--require ${path.join(checkout, 'tools', 'prepare.js')}`, `git=${path.join(checkout, 'tools', 'git.js')}`,
            'script-shell=/bin/sh', 'prefix=/tmp/example', 'globalconfig=/tmp/example/npmrc', 'onload-script=./tools/prepare.js', 'init-module=./tools/prepare.js',
            'registry=https://registry.example.com/', '@example-org:registry=https://npm.example.com/', 'strict-ssl=true', 'cafile=./certs/example-ca.pem',
            '//npm.example.com/:_authToken=${EXAMPLE_TOKEN}', '//npm.example.com/:always-auth=true', '; a comment',
        ].join('\n');
        try {
            const used = await round({
                'package-lock.json': lock, '.npmrc': npmrc, 'packages/app/.npmrc': 'node-options=--require ./x.js\nregistry=https://registry.example.com/\n',
                'tools/prepare.js': payload, 'tools/git.js': payload,
                '.yarnrc.yml': 'npmRegistryServer: https://registry.example.com\nnpmScopes:\n  example-org:\n    npmRegistryServer: https://npm.example.com\n    npmAuthToken: x\n    npmPublishRegistry: https://p.example.com\nplugins:\n  - path: .yarn/plugins/p.cjs\ninjectEnvironmentFiles: [.env]\n',
                'bunfig.toml': 'preload = ["./tools/prepare.js"]\n[install]\nregistry = "https://registry.example.com"\ncache = "/tmp/x"\n[install.scopes]\nexample-org = "https://npm.example.com"\n[run]\nshell = "system"\n',
                'pnpm-workspace.yaml': 'packages:\n  - packages/*\nnodeOptions: --require ./tools/prepare.js\npnpmfile: ./tools/prepare.js\noverrides:\n  example-tool: 1.0.0\n',
            });
            expect(fs.existsSync(marker)).toBe(false); // nothing of the commit ran
            expect(installs[0].npmrc).toBe(['registry=https://registry.example.com/', '@example-org:registry=https://npm.example.com/', 'strict-ssl=true', 'cafile=./certs/example-ca.pem', '//npm.example.com/:always-auth=true', ''].join('\n'));
            expect(installs[0].read('packages/app/.npmrc')).toBe('registry=https://registry.example.com/\n');
            expect(installs[0].read('.yarnrc.yml')).toBe('npmRegistryServer: https://registry.example.com\nnpmScopes:\n  example-org:\n    npmRegistryServer: https://npm.example.com\n    npmAuthToken: x\n');
            expect(installs[0].read('bunfig.toml')).toBe('[install]\nregistry = "https://registry.example.com"\n[install.scopes]\nexample-org = "https://npm.example.com"\n');
            expect(installs[0].read('pnpm-workspace.yaml')).toBe('packages:\n  - packages/*\noverrides:\n  example-tool: 1.0.0\n');
            expect(installs[0].files.some(f => f.startsWith('tools/'))).toBe(false);
            expect(used.settingsLeftOut).toEqual([
                { file: '.npmrc', keys: ['node-options', 'git', 'script-shell', 'prefix', 'globalconfig', 'onload-script', 'init-module', '//npm.example.com/:_authToken (expands a variable)'] },
                { file: '.yarnrc.yml', keys: ['npmScopes.example-org.npmPublishRegistry', 'plugins', 'injectEnvironmentFiles'] },
                { file: 'bunfig.toml', keys: ['preload', 'install.cache', 'run.shell'] },
                { file: 'packages/app/.npmrc', keys: ['node-options'] },
                { file: 'pnpm-workspace.yaml', keys: ['nodeOptions', 'pnpmfile'] },
            ]);
            const text = formatBacktest([last!]);
            expect(text).toContain("install settings left out of the commit's .npmrc: 8 key(s) (node-options, git, script-shell, prefix, globalconfig, onload-script, init-module, //npm.example.com/:_authToken (expands a variable))");
            expect(text).not.toContain('/bin/sh'); // names, never values
        } finally {
            fs.rmSync(marker, { force: true });
        }
    }, 60_000);

    it('leaves out an allowed setting that expands a variable, unless --deps-env', async () => {
        const files = { 'package-lock.json': 'lock 9', '.npmrc': 'registry=https://registry.example.com/\n//registry.example.com/:_authToken=${HTTPS_PROXY}\n', 'bunfig.toml': '[install]\nregistry = "$HTTPS_PROXY"\n' };
        const minimal = await round(files);
        expect(installs[0].npmrc).toBe('registry=https://registry.example.com/\n');
        expect(minimal.settingsLeftOut).toEqual([{ file: '.npmrc', keys: ['//registry.example.com/:_authToken (expands a variable)'] }, { file: 'bunfig.toml', keys: ['install.registry (expands a variable)'] }]);
        const opted = await round({ ...files, 'package-lock.json': 'lock 10' }, { depsEnv: true });
        expect(installs[1].npmrc).toBe(files['.npmrc']);
        expect(opted.settingsLeftOut).toBeUndefined();
    }, 60_000);

    it('keeps the install from finding a project above it: pnpm without a workspace of the commit\'s, yarn 2+ by its rc file name, and a cache under a project falls back', async () => {
        await round({ 'pnpm-lock.yaml': 'lock 11' });
        expect(installs[0].args).toContain('--ignore-workspace');
        await round({ 'yarn.lock': 'lock 12', '.yarnrc.yml': 'npmRegistryServer: https://registry.example.com\n' });
        expect(installs[1].args).toEqual(['install', '--immutable', '--mode=skip-build']);
        expect(installs[1].files).toContain('.rigour-yarnrc.yml');
        expect(installs[1].files).not.toContain('.yarnrc.yml');
        expect(installs[1].env?.YARN_RC_FILENAME).toBe('.rigour-yarnrc.yml');
        fs.writeFileSync(path.join(home, 'package.json'), '{}'); // the cache now sits under a project
        const under = await round({ 'package-lock.json': 'lock 13' });
        expect(under.used).toBe('today');
        expect(under.detail).toContain(`sits under ${path.join(home, 'package.json')}, which the package manager would read as a project of its own`);
        expect(installs).toHaveLength(2);
    }, 60_000);

    it('does not install a commit whose patch names a path outside its package', async () => {
        const patch = 'diff --git a/../../escaped.txt b/../../escaped.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../../escaped.txt\n@@ -0,0 +1 @@\n+escaped\n';
        const used = await round({ 'pnpm-lock.yaml': 'lock 14', 'pnpm-workspace.yaml': 'packages: []\npatchedDependencies:\n  example-tool@1.0.0: patches/example-tool.patch\n', 'patches/example-tool.patch': patch });
        expect(used).toEqual({ used: 'today', detail: "the commit's patches/example-tool.patch names a path outside its package (.. or absolute), so Rigour does not install it" });
        expect(installs).toEqual([]);
        const fine = await round({ 'pnpm-lock.yaml': 'lock 15', 'patches/example-tool.patch': 'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-a\n+b\n' });
        expect(fine.used).toBe('commit');
    }, 60_000);
});
