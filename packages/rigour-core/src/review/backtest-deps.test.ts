import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../types/index.js';
import { repositoryIdSync } from '../storage/repository-origin.js';
import { defaultExec, type Exec } from './reviewer/exec.js';
import { formatBacktest, runBacktest, type Ledger } from './backtest.js';

describe('a backtest round runs on the dependencies of its commit', () => {
    let repo: string;
    let home: string;
    const savedHome = process.env.RIGOUR_HOME;
    /** This repository's dependency cache, under the test's own RIGOUR_HOME. */
    const cache = () => path.join(home, '.rigour', 'cache', 'backtest-deps', repositoryIdSync(repo).slice(0, 16));
    let installs: Array<{ command: string; args: string[]; lock: string }>;
    let failing: Set<string>;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };
    // The package manager is stubbed (a real install is slow and networked); git and the files are real.
    const exec: Exec = async (command, args, options) => {
        if (command !== 'npm') return defaultExec(command, args, options);
        const lock = fs.readFileSync(path.join(options.cwd, 'package-lock.json'), 'utf8');
        installs.push({ command, args, lock });
        if (failing.has(lock)) return { exitCode: 1, stdout: '', stderr: 'npm error the registry could not be reached' };
        fs.mkdirSync(path.join(options.cwd, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'node_modules', 'installed-from'), lock);
        return { exitCode: 0, stdout: '', stderr: '' };
    };
    /** A commit on its own branch whose lockfile says `lock`. */
    const commitWithLock = (lock: string): string => {
        git('checkout', '-q', '-B', `lock-${lock}`, 'main');
        write('package-lock.json', lock);
        git('add', '-A');
        git('commit', '-qm', `lockfile ${lock}`);
        const sha = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
        return sha;
    };
    const run = async (locks: string[], options: { shareDeps?: boolean } = {}) => {
        const base = git('rev-parse', 'main');
        const ledger: Ledger = { rounds: locks.map((lock, i) => ({ id: `r${i}`, commit: lock === 'today' ? base : commitWithLock(lock), base, points: [], must_not_flag: [] })) };
        const seen: string[] = [];
        const results = await runBacktest(repo, ConfigSchema.parse({ version: 1 }), ledger, { exec, ...options, progress: () => undefined, collect: async tree => {
            const modules = path.join(tree, 'node_modules');
            seen.push(fs.existsSync(path.join(modules, 'installed-from')) ? fs.readFileSync(path.join(modules, 'installed-from'), 'utf8') : fs.readdirSync(modules).join(','));
            return { items: [] };
        } });
        return { results, seen };
    };

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-home-'));
        process.env.RIGOUR_HOME = home;
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-deps-'));
        installs = [];
        failing = new Set();
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('.gitignore', 'node_modules\n');
        write('package.json', '{ "name": "example-shop", "private": true }\n');
        write('package-lock.json', 'today');
        git('add', '-A');
        git('commit', '-qm', 'base');
        write('node_modules/today-marker', ''); // this checkout's installed dependencies
    });
    afterEach(() => {
        if (savedHome === undefined) delete process.env.RIGOUR_HOME;
        else process.env.RIGOUR_HOME = savedHome;
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        try { git('worktree', 'prune'); } catch { /* the repository may be gone */ }
        fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('shares this checkout\'s node_modules when the lockfile is the same, and installs the commit\'s own otherwise, once per lockfile', async () => {
        const { results, seen } = await run(['today', 'v2', 'v2', 'today']);
        expect(seen).toEqual(['today-marker', 'v2', 'v2', 'today-marker']);
        expect(results.map(r => r.replay?.dependencies.used)).toEqual(['same-lockfile', 'commit', 'commit', 'same-lockfile']);
        expect(installs).toHaveLength(1); // the second round with that lockfile reused the cache
        expect(installs[0].args).toEqual(['ci', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund']);
        expect(results[1].replay?.dependencies.detail).toBe(results[2].replay?.dependencies.detail);
        expect(fs.realpathSync(path.join(repo, '.git', 'rigour-backtest', 'checkout', 'node_modules'))).toBe(fs.realpathSync(path.join(repo, 'node_modules')));
    }, 60_000);

    it('keeps only the three installs used last', async () => {
        await run(['v1', 'v2', 'v3', 'v4', 'v5']);
        expect(installs.map(i => i.lock)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
        expect(fs.readdirSync(cache())).toHaveLength(3);
        const { seen } = await run(['v5']); // still cached: no install
        expect([seen, installs.length]).toEqual([['v5'], 5]);
    }, 60_000);

    it('runs on today\'s dependencies when the install fails or --share-deps asks, and says so', async () => {
        failing.add('broken');
        const { results, seen } = await run(['broken', 'v2'], { shareDeps: false });
        expect(seen).toEqual(['today-marker', 'v2']);
        expect(results[0].replay?.dependencies).toEqual({ used: 'today', detail: expect.stringContaining('installing the commit\'s lockfile failed: npm ci') });
        expect(formatBacktest(results)).toContain("dependencies: today's, not the commit's (installing the commit's lockfile failed");
        expect(fs.readdirSync(cache())).toHaveLength(1); // the failed install left nothing behind
        const shared = await run(['v3'], { shareDeps: true });
        expect(shared.seen).toEqual(['today-marker']);
        expect(shared.results[0].replay?.dependencies).toEqual({ used: 'today', detail: '--share-deps' });
        expect(installs.map(i => i.lock)).toEqual(['broken', 'v2']);
    }, 60_000);
});
