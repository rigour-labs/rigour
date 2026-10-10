import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asUserLevel, disableHere, enabledHere, enableHere } from './personal.js';
import { setupCommand } from './setup.js';
import { uninstall } from './uninstall.js';

let repo: string;
let home: string;
let bin: string;
const saved = { RIGOUR_AGENT_HOME: process.env.RIGOUR_AGENT_HOME, RIGOUR_CLAUDE_CLI: process.env.RIGOUR_CLAUDE_CLI, RIGOUR_HOME: process.env.RIGOUR_HOME };
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const atHome = (rel: string) => path.join(home, rel);
const windows = process.platform === 'win32';
/** The built CLI, which CI builds before it tests: the hooks below run it as an agent would. */
const builtCli = path.resolve(__dirname, '../../dist/cli.js');

/**
 * A `claude` CLI that keeps its MCP servers in a file, so add/get/remove behave like the real one. A Node script behind
 * the shim npm would install: `claude.cmd` on Windows, an executable script elsewhere.
 */
function fakeClaude(): string {
    const servers = path.join(bin, 'claude-mcp.txt');
    const log = path.join(bin, 'claude-calls.log');
    const script = path.join(bin, 'claude.js');
    fs.writeFileSync(script, `const fs = require('fs');
const [a, b, c, , e] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const servers = () => fs.existsSync(${JSON.stringify(servers)}) ? fs.readFileSync(${JSON.stringify(servers)}, 'utf8').split('\\n') : [];
if (a === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a === 'mcp' && b === 'get') process.exit(servers().includes(c) ? 0 : 1);
if (a === 'mcp' && b === 'add') { fs.appendFileSync(${JSON.stringify(servers)}, e + '\\n'); process.exit(0); }
if (a === 'mcp' && b === 'remove') { fs.writeFileSync(${JSON.stringify(servers)}, ''); process.exit(0); }
process.exit(1);
`);
    const shim = path.join(bin, windows ? 'claude.cmd' : 'claude');
    fs.writeFileSync(shim, windows ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    process.env.RIGOUR_CLAUDE_CLI = shim;
    return log;
}

/** The shells an agent may run a hook command in, those this machine has: bash (Git Bash on Windows) and PowerShell. */
const shells = [['bash', ['-c']], [windows ? 'powershell' : 'pwsh', ['-NoProfile', '-Command']]]
    .filter(([shell]) => spawnSync(shell as string, [...(shell === 'bash' ? ['-c', 'exit 0'] : ['-NoProfile', '-Command', 'exit 0'])]).status === 0) as Array<[string, string[]]>;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-repo-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-home-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-bin-'));
    // The agents' home and Rigour's own, both throwaway (os.homedir() would ignore a HOME set here).
    process.env.RIGOUR_AGENT_HOME = home;
    process.env.RIGOUR_HOME = home;
    git('init', '-q', '-b', 'main');
    git('config', 'core.hooksPath', '.git/hooks');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'app' }));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const dir of [repo, home, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the switch for a repository', () => {
    it('lives in the git directory, shared by worktrees, and puts .rigour/ in info/exclude once', () => {
        expect(enabledHere(repo)).toBe(false);
        enableHere(repo);
        enableHere(repo);
        expect(enabledHere(repo)).toBe(true);
        expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n').filter(l => l === '.rigour/')).toHaveLength(1);
        const worktree = path.join(os.tmpdir(), `personal-wt-${process.pid}`);
        git('worktree', 'add', '-q', '--detach', worktree);
        try {
            expect(enabledHere(worktree)).toBe(true);
        } finally {
            git('worktree', 'remove', '--force', worktree);
        }
        disableHere(repo, true);
        expect(enabledHere(repo)).toBe(false);
        expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8')).not.toContain('.rigour/');
    });
});

describe('the guard on a machine-level hook', () => {
    /** The command a project hook becomes in the user-level Claude settings. */
    const guarded = (command: string): string => JSON.parse(asUserLevel({ path: '.claude/settings.json', content: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } }) }).content).hooks.UserPromptSubmit[0].hooks[0].command;
    /** One team rule, about a folder the repository has. */
    const teamRule = () => {
        fs.writeFileSync(path.join(repo, 'AGENTS.md'), '- Every job in `src/jobs/` must call `withLock()` before its first read.\n');
        fs.mkdirSync(path.join(repo, 'src/jobs'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src/jobs/send.ts'), 'export const send = 1;\n');
        git('add', '-A');
        git('commit', '-qm', 'jobs');
    };
    /** What Claude Code sends to a prompt hook. */
    const payload = (cwd: string, session = 's1') => JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: 'add a job in src/jobs', cwd });

    it('is a plain command: the CLI checks the switch, no shell guard', () => {
        expect(guarded('npx --yes @rigour-labs/cli@6.13.0 hooks brief')).toBe('npx --yes @rigour-labs/cli@6.13.0 hooks brief --if-enabled');
    });

    it('runs alike in bash and in PowerShell: silent where Rigour is off, the briefing where it is on, in the project Claude Code names', () => {
        teamRule();
        const command = guarded(`node "${builtCli}" hooks brief`);
        // Started outside the project, as an agent may start it: the project comes from CLAUDE_PROJECT_DIR. A session per
        // run, since the prompt briefing is given once per session.
        const run = ([shell, args]: [string, string[]]) => spawnSync(shell, [...args, command], { cwd: os.tmpdir(), input: payload(repo, `s-${shell}`), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
        expect(shells.map(s => s[0])).toContain('bash'); // Git Bash on Windows
        for (const shell of shells) expect(run(shell), shell[0]).toMatchObject({ status: 0, stdout: '' });
        enableHere(repo);
        for (const shell of shells) {
            const result = run(shell);
            expect(result.status, shell[0]).toBe(0);
            expect(result.stdout, shell[0]).toContain('must call `withLock()`');
        }
    });

    it("finds the project from the payload's cwd when the agent names none", () => {
        enableHere(repo);
        teamRule();
        const env = { ...process.env };
        delete env.CLAUDE_PROJECT_DIR;
        const result = spawnSync(process.execPath, [builtCli, 'hooks', 'brief', '--if-enabled'], { cwd: os.tmpdir(), input: payload(repo), encoding: 'utf8', env });
        expect(result.stdout).toContain('must call `withLock()`');
    });

    it("turns each project hook file into its agent's user-level twin, every command guarded", () => {
        const claude = asUserLevel({ path: '.claude/settings.json', content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx rigour hooks stop' }] }] } }) });
        expect(claude.path).toBe('.claude/settings.json');
        expect(JSON.parse(claude.content).hooks.Stop[0].hooks[0].command).toBe('npx rigour hooks stop --if-enabled');
        expect(asUserLevel({ path: '.windsurf/hooks.json', content: '{}' }).path).toBe('.codeium/windsurf/hooks.json');
        const cline = asUserLevel({ path: '.clinerules/hooks/PostToolUse', content: '#!/usr/bin/env node\nprocess.stdout.write("ran");\n' });
        expect(cline.path).toBe('Documents/Cline/Hooks/PostToolUse');
        fs.writeFileSync(path.join(bin, 'hook.js'), cline.content);
        expect(spawnSync(process.execPath, [path.join(bin, 'hook.js')], { cwd: repo, encoding: 'utf8' }).stdout).toBe('{}');
        enableHere(repo);
        expect(spawnSync(process.execPath, [path.join(bin, 'hook.js')], { cwd: repo, encoding: 'utf8' }).stdout).toBe('ran');
    });
});

describe('rigour setup, personal', () => {
    it('leaves the working tree untouched, installs machine hooks into the configs the person has, and comes back out exactly', async () => {
        const calls = fakeClaude();
        const ownSettings = { permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npm run format' }] }] } };
        fs.mkdirSync(atHome('.claude'), { recursive: true });
        fs.writeFileSync(atHome('.claude/settings.json'), JSON.stringify(ownSettings));
        fs.mkdirSync(atHome('.cursor')); // Cursor is installed here; Windsurf and Cline are not

        await setupCommand(repo, { semantic: false });

        expect(git('status', '--porcelain', '--untracked-files=all')).toBe(''); // nothing in the working tree
        expect(enabledHere(repo)).toBe(true);
        expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toContain('hooks push --git');
        const settings = JSON.parse(fs.readFileSync(atHome('.claude/settings.json'), 'utf8'));
        expect(settings.permissions).toEqual(ownSettings.permissions);
        const commands = JSON.stringify(settings.hooks);
        expect(commands).toContain('npm run format');
        expect(commands).toContain('--if-enabled'); // every Rigour hook is guarded
        expect(commands).not.toContain('sh -c'); // and runs in any shell
        for (const rel of ['.cursor/hooks.json', '.cursor/mcp.json']) expect(fs.existsSync(atHome(rel)), rel).toBe(true);
        for (const rel of ['.codeium', 'Documents']) expect(fs.existsSync(atHome(rel)), rel).toBe(false); // nothing for an agent that is not installed
        expect(fs.readFileSync(calls, 'utf8')).toMatch(/^mcp add --scope user rigour -- /m);

        // Setting up a second repository reuses the machine install: one Rigour entry per event, not two.
        await setupCommand(repo, { semantic: false });
        const again = JSON.parse(fs.readFileSync(atHome('.claude/settings.json'), 'utf8'));
        expect(again.hooks.Stop).toHaveLength(1);

        // This repository off: the machine hooks stay, silent here now.
        uninstall(repo);
        expect(enabledHere(repo)).toBe(false);
        expect(fs.existsSync(path.join(repo, '.git/hooks/pre-push'))).toBe(false);
        expect(fs.existsSync(atHome('.cursor/hooks.json'))).toBe(true);

        // Off the machine: the person's own settings are back as they were.
        uninstall(repo, { machine: true });
        expect(JSON.parse(fs.readFileSync(atHome('.claude/settings.json'), 'utf8'))).toEqual(ownSettings);
        for (const rel of ['.cursor/hooks.json', '.codeium/windsurf/hooks.json', 'Documents/Cline/Hooks/PostToolUse', '.cursor/mcp.json']) {
            expect(fs.existsSync(atHome(rel))).toBe(false);
        }
        expect(fs.readFileSync(calls, 'utf8')).toMatch(/^mcp remove --scope user rigour$/m);
        expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    });
});

describe('rigour setup --team', () => {
    it('commits the configuration, without instruction files or empty documents unless asked', async () => {
        await setupCommand(repo, { semantic: false, team: true });
        expect(fs.existsSync(path.join(repo, 'rigour.yml'))).toBe(true);
        expect(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).toContain('hooks check');
        for (const rel of ['CLAUDE.md', 'AGENTS.md', 'docs/AGENT_INSTRUCTIONS.md', 'docs/SPEC.md', 'docs/ARCH.md']) expect(fs.existsSync(path.join(repo, rel))).toBe(false);
        expect(enabledHere(repo)).toBe(false); // machine hooks stay silent beside the committed ones
    });

    it('writes instruction files where the project has none when asked', async () => {
        await setupCommand(repo, { semantic: false, team: true, instructions: true });
        expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(true);
    });

    it("leaves a teammate's clone exactly as committed, and still writes instructions when asked", async () => {
        await setupCommand(repo, { semantic: false, team: true });
        git('add', '-A');
        git('commit', '-qm', 'adopt rigour');

        await setupCommand(repo, { semantic: false }); // a teammate after cloning: rigour.yml is tracked
        expect(git('status', '--porcelain')).toBe(''); // no committed file changed
        expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toContain('hooks push --git');

        await setupCommand(repo, { semantic: false, instructions: true });
        expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    });

    it('keeps a .cursor/mcp.json that is not valid JSON', async () => {
        fs.mkdirSync(path.join(repo, '.cursor'));
        fs.writeFileSync(path.join(repo, '.cursor/mcp.json'), '{ not json');
        await setupCommand(repo, { semantic: false, team: true });
        expect(fs.readFileSync(path.join(repo, '.cursor/mcp.json'), 'utf8')).toBe('{ not json');
    });
});

describe('rigour setup, personal, with git hooks kept in the repository', () => {
    it('leaves a committed hooks folder (Husky) alone and says what to add', async () => {
        fs.mkdirSync(path.join(repo, '.husky'));
        fs.writeFileSync(path.join(repo, '.husky/pre-push'), 'npm test\n');
        git('add', '-A');
        git('commit', '-qm', 'husky');
        git('config', 'core.hooksPath', '.husky');

        await setupCommand(repo, { semantic: false });
        expect(fs.readFileSync(path.join(repo, '.husky/pre-push'), 'utf8')).toBe('npm test\n');
        expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
        expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('hooks push --git "$@" || exit $?');
    });
});
