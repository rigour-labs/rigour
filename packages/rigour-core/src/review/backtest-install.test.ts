import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { defaultExec, type Exec } from './reviewer/exec.js';
import { runBacktest, type BacktestOptions, type Ledger } from './backtest.js';

const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

describe('installing a commit\'s dependencies runs none of the commit\'s code', () => {
    let repo: string;
    let installs: Array<{ command: string; args: string[]; files: string[]; env?: Record<string, string>; unset?: string[]; npmrc?: string; yarnrc?: string }>;
    let fail: string | undefined;
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
        installs.push({ command, args, files: listFiles(options.cwd).sort(), env: options.env, unset: options.unset, npmrc: read('.npmrc'), yarnrc: read('.yarnrc') });
        if (fail === 'throw') throw new Error('the package manager could not start');
        if (fail) return { exitCode: 1, stdout: '', stderr: fail };
        fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    /** A commit on its own branch with these files, run as one round. */
    const round = async (files: Record<string, string>, options: Partial<BacktestOptions> = {}, links: Record<string, string> = {}) => {
        git('checkout', '-q', '-B', `round-${installs.length}-${Object.keys(files).join('-')}`, 'main');
        for (const [rel, body] of Object.entries(files)) write(rel, body);
        for (const [rel, target] of Object.entries(links)) fs.symlinkSync(target, path.join(repo, rel));
        git('add', '-A');
        git('commit', '-qm', 'round');
        const commit = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
        const ledger: Ledger = { rounds: [{ id: 'r1', commit, base: commit, points: [], must_not_flag: [] }] };
        const results = await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { exec, ...options, progress: () => undefined, collect: async () => ({ items: [] }) });
        return results[0].replay!.dependencies;
    };

    beforeEach(() => {
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
        expect(berry).toEqual({ used: 'today', detail: 'this commit installs with its own yarn release, which Rigour does not run' });
        expect(installs).toEqual([]); // nothing ran
        const classic = await round({ 'yarn.lock': 'lock 4', '.yarnrc': 'yarn-path "./tools/yarn.js"\nregistry "https://registry.example.com"\n' });
        expect(classic.used).toBe('commit');
        expect(installs[0].yarnrc).toBe('\nregistry "https://registry.example.com"\n');
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
            expect(minimal.env?.HOME).toMatch(/rigour-backtest[\\/]deps[\\/][0-9a-f]{16}[\\/]\.rigour-home$/);
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
        expect(fs.readdirSync(path.join(repo, '.git', 'rigour-backtest', 'deps'))).toHaveLength(1); // nothing of the failed one is kept
    }, 60_000);
});
