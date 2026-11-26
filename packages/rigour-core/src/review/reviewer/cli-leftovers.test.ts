import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeCodexTrust } from './cli-leftovers.js';

const here = path.dirname(new URL(import.meta.url).pathname);

describe("removing codex's trust entries", () => {
    let home: string;
    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    });
    afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

    const config = 'model = "example-model"\n\n[projects."/tmp/rigour-judge-copy-AbC123/repo"]\ntrust_level = "trusted"\n';
    const ours = (p: string) => p === '/tmp/rigour-judge-copy-AbC123/repo';
    const file = () => path.join(home, 'config.toml');
    const holder = (pid: number) => JSON.stringify({ pid, started: execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }).trim() });

    it('in a folder it cannot write (0555): says so at once, leaves the entry, and never waits', () => {
        fs.writeFileSync(file(), config);
        fs.chmodSync(home, 0o555);
        try {
            const started = Date.now();
            expect(removeCodexTrust(home, ours)).toBe(`could not lock ${fs.realpathSync(file())}: EACCES; trust entry left in place`);
            expect(Date.now() - started).toBeLessThan(1000);
        } finally {
            fs.chmodSync(home, 0o755);
        }
        expect(fs.readFileSync(file(), 'utf8')).toBe(config);
    });

    it('waits for a live holder at most five seconds, however old its lock, then leaves the entry; a gone holder\'s lock is taken over', () => {
        fs.writeFileSync(file(), config);
        const lock = `${fs.realpathSync(file())}.rigour.lock`;
        const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
        try {
            fs.writeFileSync(lock, holder(sleeper.pid!));
            fs.utimesSync(lock, 0, 0); // a day-old lock is still its live holder's
            const started = Date.now();
            expect(removeCodexTrust(home, ours)).toMatch(/held it for 5 s; trust entry left in place$/);
            expect(Date.now() - started).toBeLessThan(8000);
            expect(fs.readFileSync(file(), 'utf8')).toBe(config);
        } finally {
            sleeper.kill('SIGKILL');
        }
        const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
        fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), started: 'Thu Jan  1 00:00:00 2026' }));
        expect(removeCodexTrust(home, ours)).toBeUndefined();
        expect(fs.readFileSync(file(), 'utf8')).toBe('model = "example-model"\n');
        expect(fs.existsSync(lock)).toBe(false);
    }, 20_000);

    it('takes a gone holder\'s lock over by moving it aside first: a lock another waiter took meanwhile is put back, never deleted', () => {
        fs.writeFileSync(file(), config);
        const lock = `${fs.realpathSync(file())}.rigour.lock`;
        const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();
        fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead), started: 'Thu Jan  1 00:00:00 2026' }));
        const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
        const taken = holder(sleeper.pid!);
        const rename = fs.renameSync;
        // Between this waiter's check and its move, another waiter took the lock over and re-took it.
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            if (String(from) === lock && !fs.readFileSync(lock, 'utf8').includes(String(sleeper.pid))) fs.writeFileSync(lock, taken);
            return rename(from, to);
        }) as typeof fs.renameSync);
        try {
            expect(removeCodexTrust(home, ours)).toMatch(/held it for 5 s; trust entry left in place$/);
        } finally {
            spy.mockRestore();
            sleeper.kill('SIGKILL');
        }
        expect(fs.readFileSync(lock, 'utf8')).toBe(taken); // the other waiter's lock, still there
        expect(fs.readdirSync(home).filter(name => /stale/.test(name))).toEqual([]);
        expect(fs.readFileSync(file(), 'utf8')).toBe(config);
    }, 20_000);

    it('leaves the file alone when it changed between Rigour\'s read and its rename (codex takes no lock)', () => {
        fs.writeFileSync(file(), config);
        const read = fs.readFileSync;
        let reads = 0;
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
            const text = read(p, o as BufferEncoding);
            return String(p).endsWith('config.toml') && ++reads === 2 ? `${text}# codex wrote meanwhile\n` : text;
        }) as typeof fs.readFileSync);
        try {
            expect(removeCodexTrust(home, ours)).toBe(`${fs.realpathSync(file())} changed while Rigour edited it; trust entry left in place`);
        } finally {
            spy.mockRestore();
        }
        expect(fs.readFileSync(file(), 'utf8')).toBe(config);
        expect(fs.readdirSync(home).filter(name => /lock|tmp/.test(name))).toEqual([]);
    });

    it('from two processes at once loses neither one\'s removals and changes no other line', async () => {
        const entry = (p: string) => `[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`;
        const paths = (who: string) => Array.from({ length: 40 }, (_, i) => `/tmp/rigour-judge-copy-${who}${i}/repo`);
        const kept = `model = "example-model"\n\n${entry('/Users/dev-a/project')}\n[model_providers.acme]\nbase_url = "https://llm.example.com"\n`;
        fs.writeFileSync(path.join(home, 'config.toml'), [kept, ...paths('a').map(entry), ...paths('b').map(entry)].join('\n'), { mode: 0o600 });
        const remover = (who: string) => {
            const script = [
                `import { removeCodexTrust } from ${JSON.stringify(pathToFileURL(path.join(here, 'cli-leftovers.ts')).href)};`,
                `for (const p of ${JSON.stringify(paths(who))}) removeCodexTrust(${JSON.stringify(home)}, project => project === p);`,
            ].join('\n');
            const file = path.join(home, `remove-${who}.mts`);
            fs.writeFileSync(file, script);
            const child = spawn(process.execPath, ['--import', 'tsx', file], { cwd: path.join(here, '..', '..', '..'), stdio: 'ignore' });
            return new Promise<number | null>(resolve => child.on('close', resolve));
        };
        expect(await Promise.all([remover('a'), remover('b')])).toEqual([0, 0]);
        expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe(kept);
        expect(fs.statSync(path.join(home, 'config.toml')).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(home).filter(name => /lock|tmp/.test(name))).toEqual([]);
    }, 60_000);
});
