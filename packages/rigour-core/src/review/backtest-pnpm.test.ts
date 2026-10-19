import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { runBacktest, type Ledger } from './backtest.js';

/** These run the real pnpm, offline, on a local `file:` dependency: nothing is fetched. Skipped where pnpm is not installed. */
const hasPnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasPnpm)('a backtest install with the real pnpm', () => {
    let root: string;
    let repo: string;
    let home: string;
    const savedHome = process.env.RIGOUR_HOME;
    /** The checkout's status, less the backtest's own report folder (.rigour/backtest). */
    const status = () => git('status', '--porcelain', '--ignored').split('\n').filter(line => !line.endsWith('.rigour/')).join('\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const write = (dir: string, rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
    };
    const pnpm = (cwd: string, ...args: string[]) => spawnSync('pnpm', [...args, '--offline', '--ignore-scripts'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, CI: 'true' } });
    /** A project with one local dependency, `example-dep`, whose lockfile the real pnpm wrote. */
    const project = (dir: string) => {
        write(dir, 'package.json', JSON.stringify({ name: 'example-shop', version: '1.0.0', private: true, dependencies: { 'example-dep': 'file:./example-dep' } }));
        write(dir, 'example-dep/package.json', JSON.stringify({ name: 'example-dep', version: '1.0.0' }));
    };

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-pnpm-'));
        repo = path.join(root, 'shop');
        home = path.join(root, 'home');
        fs.mkdirSync(repo);
        fs.mkdirSync(home);
        process.env.RIGOUR_HOME = home;
    });
    afterEach(() => {
        if (savedHome === undefined) delete process.env.RIGOUR_HOME;
        else process.env.RIGOUR_HOME = savedHome;
        try { git('worktree', 'prune'); } catch { /* the repository may be gone */ }
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('installs a commit with no workspace file without touching the checkout, whose own pnpm workspace is above the old cache', async () => {
        const lockDir = path.join(root, 'lock');
        project(lockDir);
        expect(pnpm(lockDir, 'install', '--lockfile-only').status).toBe(0);
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        project(repo);
        fs.copyFileSync(path.join(lockDir, 'pnpm-lock.yaml'), path.join(repo, 'pnpm-lock.yaml'));
        git('add', '-A');
        git('commit', '-qm', 'before the workspace');
        const historical = git('rev-parse', 'HEAD');
        // Today: a pnpm workspace at the checkout's root, and a lockfile of its own.
        write(repo, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
        write(repo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
        write(repo, 'package.json', JSON.stringify({ name: 'example-shop', version: '2.0.0', private: true }));
        git('add', '-A');
        git('commit', '-qm', 'a workspace');
        const lockBefore = fs.readFileSync(path.join(repo, 'pnpm-lock.yaml'));
        const statusBefore = status();
        const ledger: Ledger = { rounds: [{ id: 'r1', commit: historical, base: historical, points: [], must_not_flag: [] }] };
        const [result] = await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { progress: () => undefined, collect: async () => ({ items: [] }) });
        expect(fs.readFileSync(path.join(repo, 'pnpm-lock.yaml')).equals(lockBefore)).toBe(true);
        expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
        expect(status()).toBe(statusBefore);
        expect(result.replay?.dependencies.used).toBe('commit');
        expect(fs.realpathSync(path.join(repo, '.git', 'rigour-backtest', 'checkout', 'node_modules')).startsWith(fs.realpathSync(home))).toBe(true);
    }, 120_000);

    it('cannot write outside a package through a patch path with ..', () => {
        const dir = path.join(root, 'patched');
        project(dir);
        write(dir, 'example-dep/index.js', 'module.exports = 1;\n');
        write(dir, 'patches/example-dep.patch', 'diff --git a/../../../escaped.txt b/../../../escaped.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../../../escaped.txt\n@@ -0,0 +1 @@\n+escaped\n');
        write(dir, 'pnpm-workspace.yaml', 'packages: []\npatchedDependencies:\n  example-dep@1.0.0: patches/example-dep.patch\n');
        const ran = pnpm(dir, 'install');
        const escaped = (function find(at: string): boolean {
            return fs.readdirSync(at, { withFileTypes: true }).some(e => e.name === 'escaped.txt' || (e.isDirectory() && find(path.join(at, e.name))));
        })(root);
        expect(escaped).toBe(false);
        expect(ran.status).not.toBe(0); // pnpm refuses the patch rather than applying it partly
    }, 120_000);
});
