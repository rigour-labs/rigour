import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupCommand } from './setup.js';

let root: string;
let repo: string;
let home: string;
const saved = { ...process.env };

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-'));
    repo = path.join(root, 'repo');
    home = path.join(root, 'home');
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    // Every write to a home goes here: the agents' configs, Rigour's state, and no real Claude CLI.
    Object.assign(process.env, { HOME: home, RIGOUR_HOME: home, RIGOUR_AGENT_HOME: home, RIGOUR_CLAUDE_CLI: '/usr/bin/false' });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});
afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

const claudeHooks = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')).hooks;

describe('rigour setup briefs the agent by default', () => {
    it('in a team repository: a prompt hook, and the credential hook briefs each first edit', async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
        await setupCommand(repo, { team: true, semantic: false });
        const hooks = claudeHooks(path.join(repo, '.claude/settings.json'));
        expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain('hooks brief');
        expect(hooks.PreToolUse.map((h: any) => h.hooks[0].command).join('\n')).toContain('--mode dlp --stdin --brief');
    });

    it('in a personal install, at user level', async () => {
        await setupCommand(repo, { semantic: false });
        const hooks = claudeHooks(path.join(home, '.claude/settings.json'));
        expect(JSON.stringify(hooks.UserPromptSubmit)).toContain('hooks brief');
    });

    it('not with --no-brief', async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
        await setupCommand(repo, { team: true, semantic: false, brief: false });
        const hooks = claudeHooks(path.join(repo, '.claude/settings.json'));
        expect(hooks.UserPromptSubmit).toBeUndefined();
        expect(JSON.stringify(hooks.PreToolUse)).not.toContain('--brief');
    });
});

describe('rigour setup replaces the old shell wrappers in place', () => {
    it("swaps a team install's `sh -c` push wrapper for the plain command and keeps the person's own hooks", async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
        fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
        const old = `sh -c 'payload=$(cat); case "$payload" in *git*push*) printf "%s" "$payload" | npx --yes @rigour-labs/cli@6.12.4 hooks push --stdin ;; esac'`;
        fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old }] }, { matcher: 'Write', hooks: [{ type: 'command', command: 'npm run format' }] }] } }));
        await setupCommand(repo, { team: true, semantic: false });
        const text = fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8');
        expect(text).not.toContain('sh -c');
        expect(text).toContain('hooks push --stdin');
        expect(text).toContain('npm run format');
    });
});

describe('rigour setup --report-only and --block', () => {
    const marker = () => path.join(repo, '.git', 'rigour-report-only');
    it("sets the person's switch in the git directory, and --block clears it", async () => {
        await setupCommand(repo, { semantic: false, reportOnly: true });
        expect(fs.existsSync(marker())).toBe(true);
        expect(fs.existsSync(path.join(repo, 'rigour.yml'))).toBe(false); // nothing in the working tree
        await setupCommand(repo, { semantic: false, block: true });
        expect(fs.existsSync(marker())).toBe(false);
    });

    it("says so, and sets nothing, where the team's rigour.yml requires blocking", async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\nhooks:\n  report_only: false\n');
        await setupCommand(repo, { semantic: false, reportOnly: true });
        expect(vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n')).toContain("the team's rigour.yml requires blocking here");
    });

    it("with --team, writes the team's switch into rigour.yml, and --block takes it out", async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
        await setupCommand(repo, { semantic: false, team: true, reportOnly: true });
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).toContain('report_only: true');
        await setupCommand(repo, { semantic: false, team: true, block: true });
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).not.toContain('report_only');
    });
});

describe('rigour setup without --team never writes into the working tree', () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const commitAll = () => {
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        git('add', '-A');
        git('commit', '-qm', 'team install');
    };
    const pinned = 'npx --yes @rigour-labs/cli@6.13.0 hooks check --stdin';
    const printed = () => vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
    const writeTeamInstall = () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\npreset: healthcare\n'); // a preset whose migration is due
        for (const dir of ['.claude', '.cursor', '.windsurf']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
        fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: pinned }] }] } }));
        fs.writeFileSync(path.join(repo, '.cursor/hooks.json'), JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: pinned }] } }));
        fs.writeFileSync(path.join(repo, '.windsurf/hooks.json'), JSON.stringify({ hooks: { post_write_code: [{ command: pinned }] } }));
        commitAll();
    };

    it("leaves a team's committed install as it is: git status stays clean, and it says what it left", async () => {
        writeTeamInstall();
        await setupCommand(repo, { semantic: false });
        expect(git('status', '--porcelain')).toBe('');
        expect(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).toContain('@6.13.0');
        for (const file of ['.claude/settings.json', '.cursor/hooks.json', '.windsurf/hooks.json']) expect(printed()).toContain(file);
        expect(printed()).toContain('These hooks pin Rigour 6.13.0; they keep running that version until someone runs `rigour setup --team` and commits the result.');
        expect(printed()).toContain('the only thing installed here');
        // The committed hooks run here; personal ones beside them would run every check twice.
        expect(fs.existsSync(path.join(home, '.claude/settings.json'))).toBe(false);
    });

    it('gives the person a personal install when the repository commits only a rigour.yml, still touching no file', async () => {
        fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
        commitAll();
        await setupCommand(repo, { semantic: false });
        expect(git('status', '--porcelain')).toBe('');
        expect(JSON.stringify(claudeHooks(path.join(home, '.claude/settings.json')))).toContain('hooks check');
        expect(printed()).toContain('This repository commits rigour.yml; `rigour setup --team` commits hooks for everyone');
    });

    it('with --team, updates the committed install and migrates rigour.yml', async () => {
        writeTeamInstall();
        await setupCommand(repo, { team: true, semantic: false });
        expect(printed()).toContain('Writes into these committed files (commit the result so everyone gets it): .claude/settings.json, .cursor/hooks.json, .windsurf/hooks.json, rigour.yml');
        expect(git('status', '--porcelain')).toContain('.claude/settings.json');
        expect(fs.readFileSync(path.join(repo, 'rigour.yml'), 'utf8')).toContain('block: true');
    });
});

describe("rigour setup in a repository whose committed hooks pin an old Rigour", () => {
    it('says the old edit hook checks nothing, and changes nothing', async () => {
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        fs.mkdirSync(path.join(repo, '.claude'));
        fs.writeFileSync(path.join(repo, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'npx --yes @rigour-labs/cli@6.10.1 hooks check --files "$TOOL_INPUT_file_path"' }] }] } }));
        for (const [key, value] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) git('config', key, value);
        git('add', '-A');
        git('commit', '-qm', 'old pin');
        await setupCommand(repo, { semantic: false });
        expect(git('status', '--porcelain')).toBe('');
        const printed = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
        expect(printed).toContain('These hooks pin Rigour 6.10.1; they keep running that version (its edit hook checks nothing) until someone runs `rigour setup --team`');
    });
});
