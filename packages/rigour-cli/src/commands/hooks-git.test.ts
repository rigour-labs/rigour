import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pinnedHomeEnv } from '@rigour-labs/core/profile';
import { setReportOnlyHere } from './report-only.js';
import { describePushGate, gitPushGateCommand, installGitPushHook, pushHookTarget, selfTestCommand, selfTestGitPushHook } from './hooks-git.js';
import { uninstall } from './uninstall.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/bin.js');

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '.git/hooks'); // a machine-wide hooks path must not reach the test
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\ngates:\n  unused_exports:\n    block: true\n'); // this team blocks on dead code
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('the git pre-push hook', () => {
    it('is installed where git looks, once, and completes a hook another tool owns instead of replacing it', () => {
        const first = installGitPushHook(repo, 'npx --yes @rigour-labs/cli@9.9.9');
        expect(first.action).toBe('installed');
        const text = fs.readFileSync(first.path, 'utf8');
        expect(text).toContain('exec npx --yes @rigour-labs/cli@9.9.9 hooks push --git "$@"');
        if (process.platform !== 'win32') expect(fs.statSync(first.path).mode & 0o111).toBeTruthy(); // no execute bit on Windows
        expect(installGitPushHook(repo, 'npx --yes @rigour-labs/cli@9.9.9').action).toBe('present');

        git('config', 'core.hooksPath', '.husky');
        fs.mkdirSync(path.join(repo, '.husky'));
        fs.writeFileSync(path.join(repo, '.husky/pre-push'), '#!/bin/sh\nnpm test\n');
        const appended = installGitPushHook(repo, 'rigour');
        expect(appended).toMatchObject({ action: 'appended', path: path.join(repo, '.husky/pre-push') });
        expect(fs.readFileSync(appended.path, 'utf8')).toBe('#!/bin/sh\nnpm test\n\n# Rigour push gate (rigour hooks init): the same gate for every tool and the terminal.\nrigour hooks push --git "$@" || exit $?\n');
        expect(installGitPushHook(repo, 'rigour').action).toBe('present');
        expect(installGitPushHook(path.join(os.tmpdir()), 'rigour').action).toBe('no repository');

        // A hooks directory outside the repository belongs to whoever set it: named, never written.
        const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'global-hooks-'));
        fs.writeFileSync(path.join(elsewhere, 'pre-push'), '#!/bin/sh\nexit 0\n');
        git('config', 'core.hooksPath', elsewhere);
        expect(installGitPushHook(repo, 'rigour')).toEqual({ path: path.join(elsewhere, 'pre-push'), action: 'managed elsewhere' });
        expect(fs.readFileSync(path.join(elsewhere, 'pre-push'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');
        fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('refuses a push from a tree with uncommitted changes to tracked files, and lets a branch deletion through', async () => {
        const refs = `refs/heads/main ${git('rev-parse', 'HEAD')} refs/heads/main 0000000000000000000000000000000000000000\n`;
        fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
        const dirty = await gitPushGateCommand(refs, repo);
        expect(dirty.exitCode).toBe(1);
        expect(dirty.message).toContain('uncommitted changes to tracked files');
        expect(dirty.message).toContain(' M a.ts');
        const deletion = await gitPushGateCommand('(delete) 0000000000000000000000000000000000000000 refs/heads/old 1234567890123456789012345678901234567890\n', repo);
        expect(deletion).toEqual({ exitCode: 0, message: '' });
    });

    it('gates only the checked-out commit: a push of another commit is refused before any check runs', async () => {
        const zero = '0000000000000000000000000000000000000000';
        let runs = 0;
        const gate = async () => { runs += 1; return { exitCode: 0 as const, message: 'passed' }; };
        const head = git('rev-parse', 'HEAD');
        const pushHead = await gitPushGateCommand(`refs/heads/main ${head} refs/heads/main ${zero}\n`, repo, gate);
        expect(pushHead).toEqual({ exitCode: 0, message: 'passed' });
        expect(runs).toBe(1);

        const twoAtHead = `refs/heads/main ${head} refs/heads/main ${zero}\nrefs/tags/v1 ${head} refs/tags/v1 ${zero}\n`;
        expect((await gitPushGateCommand(twoAtHead, repo, gate)).exitCode).toBe(0);
        expect(runs).toBe(2); // two refs at HEAD: one gate run

        git('checkout', '-qb', 'other-branch');
        fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'other');
        const other = git('rev-parse', 'HEAD');
        git('checkout', '-q', 'main');
        const refused = await gitPushGateCommand(`refs/heads/other-branch ${other} refs/heads/other-branch ${zero}\n`, repo, gate);
        expect(refused.exitCode).toBe(1);
        expect(refused.message).toBe(`Push refused: this push sends other-branch at ${other.slice(0, 7)}, but the gate checks the checked-out commit (${head.slice(0, 7)}). Check out other-branch and push from there, or run \`rigour hooks push --git\` there.`);
        expect(runs).toBe(2);

        const deleteOnly = await gitPushGateCommand(`(delete) ${zero} refs/heads/old ${other}\n`, repo, gate);
        expect(deleteOnly).toEqual({ exitCode: 0, message: '' });
        expect(runs).toBe(2);
    });

    it('peels an annotated tag to its commit: one on HEAD runs the gate, one on another commit is refused', async () => {
        const zero = '0000000000000000000000000000000000000000';
        let runs = 0;
        const gate = async () => { runs += 1; return { exitCode: 0 as const, message: 'passed' }; };
        const old = git('rev-parse', 'HEAD');
        git('tag', '-a', 'v0', '-m', 'x');
        fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'next');
        const head = git('rev-parse', 'HEAD');
        git('tag', '-a', 'v1', '-m', 'x');
        const onHead = git('rev-parse', 'refs/tags/v1');
        expect(onHead).not.toBe(head); // the tag object, as git's pre-push sends it
        expect(await gitPushGateCommand(`refs/tags/v1 ${onHead} refs/tags/v1 ${zero}\n`, repo, gate)).toEqual({ exitCode: 0, message: 'passed' });
        expect(runs).toBe(1);

        const onOld = git('rev-parse', 'refs/tags/v0');
        const refused = await gitPushGateCommand(`refs/tags/v0 ${onOld} refs/tags/v0 ${zero}\n`, repo, gate);
        expect(refused.exitCode).toBe(1);
        expect(refused.message).toContain(`this push sends refs/tags/v0 at ${old.slice(0, 7)} (tag ${onOld.slice(0, 7)}), but the gate checks the checked-out commit (${head.slice(0, 7)})`);
        expect(runs).toBe(1);
    });

    it('in report-only, lets a real git push through and says on the terminal what would have stopped it', () => {
        const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'report-remote-'));
        try {
            execFileSync('git', ['init', '-q', '--bare', remote]);
            git('remote', 'add', 'origin', remote);
            fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\ngates:\n  unused_exports:\n    block: true\n');
            fs.writeFileSync(path.join(repo, '.gitignore'), '.rigour/\n');
            git('add', '-A');
            git('commit', '-qm', 'team');
            git('push', '-q', 'origin', 'HEAD:main');
            git('checkout', '-qb', 'feature');
            installGitPushHook(repo, selfTestCommand(bin));
            fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\nexport const forgotten = 2;\n');
            git('commit', '-qam', 'adds an export nothing uses');
            setReportOnlyHere(repo, true);
            const pushed = spawnSync('git', ['push', 'origin', 'feature'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RIGOUR_TELEMETRY: '0' } });
            expect(pushed.status).toBe(0);
            expect(pushed.stderr).toContain('the push would have been blocked');
            expect(execFileSync('git', ['-C', remote, 'rev-parse', '--verify', '-q', 'refs/heads/feature'], { encoding: 'utf8' }).trim()).toBe(git('rev-parse', 'HEAD'));
        } finally {
            fs.rmSync(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    }, 120_000);

    it('holds under a real git push: a change the gate must refuse is refused, the fix lands, read from the remote', async () => {
        const result = await selfTestGitPushHook(selfTestCommand(bin));
        expect(result.steps.join('\n')).toContain('was refused');
        expect(result).toMatchObject({ ok: true });
    }, 120_000);
});

describe("an upgrade and Rigour's push-gate line", () => {
    const OLD = 'npx --yes @rigour-labs/cli@7.0.2';
    const NOW = 'npx --yes @rigour-labs/cli@7.0.5';
    /** A synthetic husky 9 layout: git runs .husky/_, which runs the tracked .husky/pre-push. */
    const husky = (script: string) => {
        git('config', 'core.hooksPath', '.husky/_');
        fs.mkdirSync(path.join(repo, '.husky', '_'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.husky/pre-push'), script);
        return path.join(repo, '.husky/pre-push');
    };
    // CRLF, a trailing space and no final newline elsewhere in the script: every byte but the version must survive.
    const script = (pin: string) => `#!/bin/sh\r\nnpm test \r\n\n# Rigour push gate (rigour hooks init): the same gate for every tool and the terminal.\n${pin} hooks push --git "$@" || exit $?\nnpm run lint`;

    it('re-pins a stale line in a tracked husky script, and changes nothing else in it', () => {
        const file = husky(script(OLD));
        const result = installGitPushHook(repo, NOW);
        expect(result).toMatchObject({ action: 'updated', path: file, stale: { version: '7.0.2' } });
        expect(fs.readFileSync(file, 'utf8')).toBe(script(NOW));
        expect(describePushGate(result, NOW)).toEqual({ ok: true, text: `UPDATE ${file}: Rigour's push gate moved to 7.0.5 (from 7.0.2)` });
    });

    it('leaves a current line, and a line that pins no version, untouched', () => {
        const file = husky(script(NOW));
        expect(installGitPushHook(repo, NOW).action).toBe('present');
        expect(fs.readFileSync(file, 'utf8')).toBe(script(NOW));
        fs.writeFileSync(file, script('rigour'));
        expect(installGitPushHook(repo, NOW).action).toBe('present');
        expect(fs.readFileSync(file, 'utf8')).toBe(script('rigour'));
    });

    it("re-pins git's own hook and an in-tree hooksPath script the same way", () => {
        const own = installGitPushHook(repo, OLD);
        expect(installGitPushHook(repo, NOW)).toMatchObject({ action: 'updated', path: own.path });
        expect(fs.readFileSync(own.path, 'utf8')).toContain(`exec ${NOW} hooks push --git "$@"`);
        git('config', 'core.hooksPath', 'hooks');
        fs.mkdirSync(path.join(repo, 'hooks'));
        fs.writeFileSync(path.join(repo, 'hooks/pre-push'), script(OLD));
        expect(installGitPushHook(repo, NOW).action).toBe('updated');
        expect(fs.readFileSync(path.join(repo, 'hooks/pre-push'), 'utf8')).toBe(script(NOW));
    });

    it('in a personal install, leaves a tracked script alone and prints the updated line, saying the old one is stale', () => {
        const file = husky(script(OLD));
        const result = installGitPushHook(repo, NOW, { workingTree: false });
        expect(result).toMatchObject({ action: 'add line', stale: { version: '7.0.2', line: `${OLD} hooks push --git "$@" || exit $?` } });
        expect(fs.readFileSync(file, 'utf8')).toBe(script(OLD));
        const said = describePushGate(result, NOW)!;
        expect(said.ok).toBe(false);
        expect(said.text).toContain('pins 7.0.2, which is stale');
        expect(said.text).toContain(`with: ${NOW} hooks push --git "$@" || exit $?`);
    });
});

describe("doctor's push-gate self-test", () => {
    it("keeps the repository's profile home in its scratch clone, even where another profile matches the temp folder", () => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'self-test-profiles-')));
        const scratch = path.join(root, 'scratch');
        fs.mkdirSync(scratch);
        const profiles = path.join(root, 'profiles.json');
        // acme is the repository's; other's match covers the temp folder the scratch clone lives in, with its own team.
        fs.writeFileSync(profiles, JSON.stringify({ profiles: [
            { name: 'acme', match: [repo], home: path.join(root, 'acme') },
            { name: 'other', match: [root], home: path.join(root, 'other'), team: { organization: 'otherorg', team: 't', actor: 'a' } },
        ] }));
        // What doctor's process holds after applying acme for the repository (profile.ts applyProfile).
        const doctor = { ...process.env, HOME: root, RIGOUR_AGENT_HOME: root, RIGOUR_PROFILES: profiles, RIGOUR_PROFILE: 'acme', RIGOUR_HOME: path.join(root, 'acme') };
        // The home the CLI runs under there: `profile which` prints it on its home line.
        const home = (env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [bin, 'profile', 'which'], { cwd: scratch, env, encoding: 'utf8' }).match(/home: (.+)/)?.[1].trim();
        try {
            expect(home(doctor)).toBe(path.join(root, 'other', '.rigour')); // inherited as is, the scratch push would run as other
            expect(home(pinnedHomeEnv(doctor))).toBe(path.join(root, 'acme', '.rigour'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
    });
});

describe('the push gate where a tool manages git hooks', () => {
    const LINE = 'rigour hooks push --git "$@" || exit $?';
    const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
    /** Husky 9: git runs `.husky/_`, generated stubs that run the tracked `.husky/pre-push`. */
    const husky9 = (generated = true) => {
        fs.mkdirSync(path.join(repo, '.husky'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.husky/pre-push'), 'npm test\n');
        if (generated) {
            fs.mkdirSync(path.join(repo, '.husky/_'));
            fs.writeFileSync(path.join(repo, '.husky/_/h'), '#!/usr/bin/env sh\n# husky\n');
            fs.writeFileSync(path.join(repo, '.husky/_/pre-push'), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
        }
        git('config', 'core.hooksPath', '.husky/_');
    };

    it("never writes into husky's generated folder: personal setup gives the line, a team install completes the tracked script", () => {
        husky9();
        expect(pushHookTarget(repo)).toEqual({ file: path.join(repo, '.husky/pre-push'), managed: 'husky' });
        const personal = installGitPushHook(repo, 'rigour', { workingTree: false });
        expect(personal).toMatchObject({ action: 'add line', path: path.join(repo, '.husky/pre-push') });
        expect(read('.husky/pre-push')).toBe('npm test\n');
        const team = installGitPushHook(repo, 'rigour');
        expect(team).toMatchObject({ action: 'appended', path: path.join(repo, '.husky/pre-push') });
        expect(read('.husky/pre-push')).toContain(`npm test\n\n# Rigour push gate`);
        expect(read('.husky/pre-push')).toContain(LINE);
        expect(read('.husky/_/pre-push')).toBe('#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n'); // husky's stub, untouched
        // rigour uninstall takes its line back out of the tracked script.
        uninstall(repo);
        expect(read('.husky/pre-push')).toBe('npm test\n');
    });

    it("in a fresh worktree whose generated folder does not exist yet, creates nothing there", () => {
        husky9(false);
        expect(installGitPushHook(repo, 'rigour').action).toBe('appended');
        expect(fs.existsSync(path.join(repo, '.husky/_'))).toBe(false);
        // With husky configured and no tracked pre-push yet, a team install creates the tracked one.
        fs.rmSync(path.join(repo, '.husky/pre-push'));
        expect(installGitPushHook(repo, 'rigour')).toMatchObject({ action: 'installed', path: path.join(repo, '.husky/pre-push') });
        expect(fs.existsSync(path.join(repo, '.husky/_'))).toBe(false);
    });

    it("never replaces another tool's hook in .git/hooks: one that hands over with exec gets no line after it", () => {
        const hook = path.join(repo, '.git/hooks/pre-push');
        fs.mkdirSync(path.dirname(hook), { recursive: true });
        fs.writeFileSync(hook, '#!/bin/sh\nexec lefthook run pre-push "$@"\n');
        expect(installGitPushHook(repo, 'rigour')).toMatchObject({ action: 'add line', reason: expect.stringContaining('exec') });
        expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nexec lefthook run pre-push "$@"\n');
    });

    it("says in doctor when husky runs the hooks and Rigour's line is missing from its script", async () => {
        husky9();
        const { doctorCommand } = await import('./doctor.js');
        const log: string[] = [];
        const spy = (await import('vitest')).vi.spyOn(console, 'log').mockImplementation((line: unknown) => { log.push(String(line)); });
        await doctorCommand({}, repo).catch(() => undefined);
        spy.mockRestore();
        expect(log.join('\n')).toContain('Push gate: managed by husky; the Rigour line is absent from');
    });
});
