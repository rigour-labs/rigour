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
const unix = process.platform !== 'win32';

/** A `claude` CLI that keeps its MCP servers in a file, so add/get/remove behave like the real one. */
function fakeClaude(): string {
    const servers = path.join(bin, 'claude-mcp.txt');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
echo "$@" >> "${path.join(bin, 'claude-calls.log')}"
case "$1 $2" in
  "--version "*) echo "9.9.9 (Claude Code)"; exit 0 ;;
  "mcp get") grep -qx "$3" "${servers}" 2>/dev/null; exit $? ;;
  "mcp add") echo "$5" >> "${servers}"; exit 0 ;;
  "mcp remove") : > "${servers}"; exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
    process.env.RIGOUR_CLAUDE_CLI = path.join(bin, 'claude');
    return path.join(bin, 'claude-calls.log');
}

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

describe.skipIf(!unix)('the guard on a machine-level hook', () => {
    /** The command a project Stop hook becomes in the user-level Claude settings. */
    const guarded = (command: string): string => JSON.parse(asUserLevel({ path: '.claude/settings.json', content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }) }).content).hooks.Stop[0].hooks[0].command;
    const run = (command: string) => spawnSync('sh', ['-c', command], { cwd: repo, input: 'payload', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });

    it('runs the command only in a repository switched on, with stdin passed through, even for a quoted command', () => {
        const command = guarded(`sh -c 'printf "ran:"; cat'`);
        expect(run(command).stdout).toBe('');
        expect(run(command).status).toBe(0);
        enableHere(repo);
        expect(run(command).stdout).toBe('ran:payload');
        const outside = spawnSync('sh', ['-c', command], { cwd: os.tmpdir(), input: 'x', encoding: 'utf8' });
        expect(outside).toMatchObject({ status: 0, stdout: '' });
    });

    it('turns each project hook file into its agent\'s user-level twin, every command guarded', () => {
        const claude = asUserLevel({ path: '.claude/settings.json', content: JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npx rigour hooks stop' }] }] } }) });
        expect(claude.path).toBe('.claude/settings.json');
        expect(JSON.parse(claude.content).hooks.Stop[0].hooks[0].command).toMatch(/^sh -c '.*rigour-enabled.*exec npx rigour hooks stop'$/);
        expect(asUserLevel({ path: '.windsurf/hooks.json', content: '{}' }).path).toBe('.codeium/windsurf/hooks.json');
        const cline = asUserLevel({ path: '.clinerules/hooks/PostToolUse', content: '#!/usr/bin/env node\nprocess.stdout.write("ran");\n' });
        expect(cline.path).toBe('Documents/Cline/Hooks/PostToolUse');
        fs.writeFileSync(path.join(bin, 'hook.js'), cline.content);
        expect(spawnSync(process.execPath, [path.join(bin, 'hook.js')], { cwd: repo, encoding: 'utf8' }).stdout).toBe('{}');
        enableHere(repo);
        expect(spawnSync(process.execPath, [path.join(bin, 'hook.js')], { cwd: repo, encoding: 'utf8' }).stdout).toBe('ran');
    });
});

describe.skipIf(!unix)('rigour setup, personal', () => {
    it('leaves the working tree untouched, installs machine hooks into the configs the person has, and comes back out exactly', async () => {
        const calls = fakeClaude();
        const ownSettings = { permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npm run format' }] }] } };
        fs.mkdirSync(atHome('.claude'), { recursive: true });
        fs.writeFileSync(atHome('.claude/settings.json'), JSON.stringify(ownSettings));

        await setupCommand(repo, { semantic: false });

        expect(git('status', '--porcelain', '--untracked-files=all')).toBe(''); // nothing in the working tree
        expect(enabledHere(repo)).toBe(true);
        expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toContain('hooks push --git');
        const settings = JSON.parse(fs.readFileSync(atHome('.claude/settings.json'), 'utf8'));
        expect(settings.permissions).toEqual(ownSettings.permissions);
        const commands = JSON.stringify(settings.hooks);
        expect(commands).toContain('npm run format');
        expect(commands).toContain('rigour-enabled'); // every Rigour hook is guarded
        for (const rel of ['.cursor/hooks.json', '.codeium/windsurf/hooks.json', 'Documents/Cline/Hooks/PostToolUse', 'Documents/Cline/Hooks/PreToolUse', '.cursor/mcp.json']) {
            expect(fs.existsSync(atHome(rel))).toBe(true);
        }
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
});
