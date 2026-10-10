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
