import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGitPushHook } from './hooks-git.js';
import { initCommand } from './init.js';
import { uninstall } from './uninstall.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};

/** Every file in the working tree (and the pre-push hook), with its content: the repository as a person would compare it. */
function snapshot(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
            const rel = path.posix.join(dir, entry.name);
            if (rel === '.git' || rel.startsWith('.rigour')) continue;
            if (entry.isDirectory()) walk(rel);
            else files[rel] = read(rel);
        }
    };
    walk('.');
    const hook = path.join(repo, '.git/hooks/pre-push');
    if (fs.existsSync(hook)) files['.git/hooks/pre-push'] = fs.readFileSync(hook, 'utf8');
    return files;
}

const OWN_SETTINGS = JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, env: { FOO: '1' }, hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'npm run format' }] }] } }, null, 2);
const OWN_MCP = JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }, null, 2);

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-'));
    git('init', '-q', '-b', 'main');
    git('config', 'core.hooksPath', '.git/hooks');
    write('package.json', JSON.stringify({ name: 'app' }));
    write('.gitignore', 'node_modules\n');
    write('AGENTS.md', '# Our own agent rules\n');
    write('.claude/settings.json', OWN_SETTINGS);
    write('.mcp.json', OWN_MCP);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('rigour uninstall', () => {
    it('after init, takes out exactly what Rigour put in: the repository is as it was, rigour.yml and .rigour/ aside', async () => {
        const before = snapshot();
        await initCommand(repo, { instructions: true });

        // What init did to the person's own files: merged, never replaced.
        const settings = JSON.parse(read('.claude/settings.json'));
        expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
        expect(settings.env).toEqual({ FOO: '1' });
        expect(settings.mcpServers).toBeUndefined(); // Claude Code reads MCP servers from .mcp.json
        expect(JSON.stringify(settings.hooks)).toContain('npm run format');
        expect(JSON.stringify(settings.hooks)).toMatch(/hooks check/);
        expect(Object.keys(JSON.parse(read('.mcp.json')).mcpServers)).toEqual(['docs', 'rigour']);
        expect(read('AGENTS.md')).toBe('# Our own agent rules\n'); // the team's own instructions are kept
        expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(true);
        expect(read('.git/hooks/pre-push')).toContain('hooks push --git');

        const dry = uninstall(repo, { dryRun: true });
        expect(dry.changes.length).toBeGreaterThan(3); // Claude Code's hooks, .mcp.json, CLAUDE.md, the git hook
        expect(snapshot()['.claude/settings.json']).toBe(read('.claude/settings.json')); // a dry run changes nothing

        uninstall(repo);
        const after = snapshot();
        const expected: Record<string, string> = { ...before, 'rigour.yml': after['rigour.yml'], '.gitignore': after['.gitignore'] };
        for (const rel of Object.keys(expected)) if (rel.endsWith('.json')) expected[rel] = JSON.stringify(JSON.parse(expected[rel]), null, 4) + '\n';
        expect(Object.keys(after).sort()).toEqual(Object.keys(expected).sort());
        expect(JSON.parse(after['.claude/settings.json'])).toEqual(JSON.parse(OWN_SETTINGS));
        expect(JSON.parse(after['.mcp.json'])).toEqual(JSON.parse(OWN_MCP));
        expect(after['AGENTS.md']).toBe('# Our own agent rules\n');

        // --all: rigour.yml, .rigour/ and the .gitignore lines go too.
        uninstall(repo, { all: true });
        expect(fs.existsSync(path.join(repo, 'rigour.yml'))).toBe(false);
        expect(fs.existsSync(path.join(repo, '.rigour'))).toBe(false);
        expect(read('.gitignore')).toBe('node_modules\n');
    });

    it('keeps a file Rigour created that the person has since edited, and says so', async () => {
        await initCommand(repo, { instructions: true });
        fs.appendFileSync(path.join(repo, 'CLAUDE.md'), '\n## Our addition\n');
        const report = uninstall(repo);
        expect(fs.existsSync(path.join(repo, 'CLAUDE.md'))).toBe(true);
        expect(report.kept).toContainEqual('CLAUDE.md: edited since Rigour created it');
    });

    it('removes only its own lines from a pre-push hook another tool owns', () => {
        write('.husky/pre-push', '#!/bin/sh\nnpm test\n');
        git('config', 'core.hooksPath', '.husky');
        installGitPushHook(repo, 'rigour');
        expect(read('.husky/pre-push')).toContain('hooks push --git');
        uninstall(repo);
        expect(read('.husky/pre-push')).toBe('#!/bin/sh\nnpm test\n');
    });
});
