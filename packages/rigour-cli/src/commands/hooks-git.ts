/**
 * Git's own pre-push hook, so the push gate is the same for every tool and for a terminal: an
 * agent's hook only covers that agent. `rigour hooks init` installs it (where git looks: the
 * hooks directory, `core.hooksPath` included); a hook another tool already owns gets one line
 * appended. The hook runs `rigour hooks push --git`, which gates the commit git is about to send:
 * HEAD, so a tree with uncommitted changes to tracked files is refused first (the gate would
 * otherwise check code the push does not carry). `git push --no-verify` is not for agents.
 *
 * `selfTestGitPushHook` is what "it printed blocked" is not: a real `git push` to a bare remote,
 * once with a change the gate must refuse and once with the fix, checked by the remote's refs.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pushGate } from './hooks-push.js';

const MARK = 'rigour hooks push --git';

export interface GitHookInstall { path: string; action: 'installed' | 'appended' | 'present' | 'no repository' | 'managed elsewhere' }

/**
 * Writes (or completes) the pre-push hook where this repository's git looks for it. A hooks
 * directory outside the repository (a machine-wide `core.hooksPath`) belongs to whoever set it:
 * Rigour names it and leaves it alone. So does a personal install (`workingTree: false`) whose hooks
 * live in the working tree (Husky's `.husky/`): those files are committed, and personal means
 * nothing in the working tree.
 */
export function installGitPushHook(cwd: string, rigourCommand: string, options: { workingTree?: boolean } = {}): GitHookInstall {
    const hooksDir = gitOutput(cwd, ['rev-parse', '--git-path', 'hooks']);
    const top = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
    const gitDir = gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!hooksDir || !top || !gitDir) return { path: '', action: 'no repository' };
    const file = path.resolve(cwd, hooksDir, 'pre-push');
    // Compared as real paths: a temp directory and git's view of it can spell the same place differently.
    const real = (p: string) => {
        try {
            return fs.realpathSync.native(p);
        } catch {
            return p;
        }
    };
    const home = real(path.dirname(file));
    const inside = (dir: string) => home === real(dir) || home.startsWith(`${real(dir)}${path.sep}`);
    if (!inside(gitDir) && (!inside(top) || options.workingTree === false)) return { path: file, action: 'managed elsewhere' };
    const line = `${rigourCommand} ${MARK.replace('rigour ', '')} "$@"`;
    if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8');
        if (text.includes(MARK.replace('rigour ', ''))) return { path: file, action: 'present' };
        fs.appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}\n${APPENDED_COMMENT}\n${line} || exit $?\n`);
        return { path: file, action: 'appended' };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gitHookScript(line), { mode: 0o755 });
    return { path: file, action: 'installed' };
}

/** The whole pre-push hook Rigour writes when the repository has none. */
function gitHookScript(line: string): string {
    return `#!/bin/sh\n# Rigour push gate (rigour hooks init): the same gate for every tool and the terminal.\n# \`git push --no-verify\` is not for agents.\nexec ${line}\n`;
}

/** The two lines Rigour appends to a pre-push hook another tool owns. */
export const APPENDED_COMMENT = '# Rigour push gate (rigour hooks init): the same gate for every tool and the terminal.';

/** `rigour hooks push --git`: git's pre-push, on the commit git is about to send. Exit 1 refuses the push. */
export async function gitPushGateCommand(stdin: string, cwd: string): Promise<{ exitCode: 0 | 1; message: string }> {
    const refs = stdin.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 4 && !/^0+$/.test(parts[1]));
    if (refs.length === 0) return { exitCode: 0, message: '' }; // deleting a remote branch: nothing is sent
    const dirty = gitOutput(cwd, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { exitCode: 1, message: `Push refused: the tree has uncommitted changes to tracked files, and the gate checks what the push sends (HEAD). Commit or stash them, then push again:\n${dirty.split('\n').slice(0, 8).map(l => `  ${l}`).join('\n')}` };
    const result = await pushGate(cwd);
    return { exitCode: result.exitCode === 0 ? 0 : 1, message: result.message };
}

export interface SelfTest { ok: boolean; steps: string[] }

/** This very CLI as a hook can run it: quoted, with forward slashes, since git runs hooks under sh where a backslash escapes. */
export function selfTestCommand(bin = process.argv[1]): string {
    const quote = (p: string) => `"${p.replace(/\\/g, '/')}"`;
    return `${quote(process.execPath)} ${quote(bin)}`;
}

/**
 * Installs the hook in a scratch clone of a scratch bare remote, pushes a change the gate must
 * refuse (an export nothing uses), then the fix, and reads the remote's refs: the exit code git
 * acted on is the evidence, not what the hook printed.
 */
export async function selfTestGitPushHook(rigourCommand: string): Promise<SelfTest> {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-hook-test-'));
    const steps: string[] = [];
    try {
        const remote = path.join(scratch, 'remote.git');
        const clone = path.join(scratch, 'clone');
        git(scratch, ['init', '-q', '--bare', remote]);
        git(scratch, ['clone', '-q', remote, clone]);
        for (const [key, value] of [['user.email', 'rigour@example.com'], ['user.name', 'rigour'], ['commit.gpgsign', 'false'], ['core.hooksPath', '.git/hooks']]) git(clone, ['config', key, value]);
        fs.mkdirSync(path.join(clone, 'src'));
        fs.writeFileSync(path.join(clone, 'src/main.ts'), "import { used } from './util';\nconsole.log(used);\n");
        fs.writeFileSync(path.join(clone, 'src/util.ts'), 'export const used = 1;\n');
        fs.writeFileSync(path.join(clone, '.gitignore'), '.rigour/\n');
        git(clone, ['add', '-A']);
        git(clone, ['commit', '-qm', 'base']);
        git(clone, ['push', '-q', '-u', 'origin', 'HEAD:main']);
        git(clone, ['checkout', '-qb', 'feature']);
        const installed = installGitPushHook(clone, rigourCommand);
        steps.push(`hook ${installed.action} at ${installed.path}`);
        fs.writeFileSync(path.join(clone, 'src/util.ts'), 'export const used = 1;\nexport const forgotten = 2;\n');
        git(clone, ['commit', '-qam', 'adds an export nothing uses']);
        const refused = spawnSync('git', ['push', 'origin', 'feature'], { cwd: clone, encoding: 'utf8', env: { ...process.env, RIGOUR_TELEMETRY: 'off' } });
        const refusedRef = gitOutput(remote, ['rev-parse', '--verify', '-q', 'refs/heads/feature']);
        if (refused.status === 0 || refusedRef) return { ok: false, steps: [...steps, `FAIL: a push with an unused export went through (git exit ${refused.status}; remote has feature: ${!!refusedRef})\n${(refused.stderr || '').trim().slice(-600)}`] };
        steps.push(`a push with an unused export was refused (git exit ${refused.status}); the remote has no feature branch`);
        fs.writeFileSync(path.join(clone, 'src/util.ts'), 'export const used = 1;\n');
        git(clone, ['commit', '-qam', 'fix']);
        const accepted = spawnSync('git', ['push', 'origin', 'feature'], { cwd: clone, encoding: 'utf8', env: { ...process.env, RIGOUR_TELEMETRY: 'off' } });
        const acceptedRef = gitOutput(remote, ['rev-parse', '--verify', '-q', 'refs/heads/feature']);
        if (accepted.status !== 0 || acceptedRef !== gitOutput(clone, ['rev-parse', 'HEAD'])) return { ok: false, steps: [...steps, `FAIL: the fixed push did not land (git exit ${accepted.status})\n${(accepted.stderr || '').trim().slice(-600)}`] };
        steps.push('the fixed push landed; the remote has the commit');
        return { ok: true, steps };
    } catch (error: any) {
        return { ok: false, steps: [...steps, `FAIL: ${String(error.message ?? error).slice(0, 300)}`] };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOutput(cwd: string, args: string[]): string | undefined {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
}
