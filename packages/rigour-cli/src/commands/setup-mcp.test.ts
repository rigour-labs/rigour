import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpPackageSpec, resolveMCPServerConfig } from './init.js';
import { registerUserMcp } from './personal.js';
import { setupCommand } from './setup.js';
import { getCliVersion } from '../utils/cli-version.js';

let root: string;
let repo: string;
const saved = { ...process.env };
const mcp = () => JSON.parse(fs.readFileSync(path.join(repo, '.mcp.json'), 'utf8')).mcpServers;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-mcp-'));
    repo = path.join(root, 'repo');
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.mkdirSync(home);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
    // Every write to a home goes here, and no real Claude CLI runs.
    Object.assign(process.env, { HOME: home, RIGOUR_HOME: home, RIGOUR_AGENT_HOME: home, RIGOUR_CLAUDE_CLI: '/usr/bin/false' });
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'error').mockImplementation(() => { });
});
afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('rigour setup registers the MCP server', () => {
    it('on a repository that already has rigour.yml (it used to write hooks only)', async () => {
        await setupCommand(repo, { team: true, semantic: false });
        expect(mcp().rigour).toEqual(resolveMCPServerConfig());
    });

    it("re-pins Rigour's own entry and keeps the person's other servers", async () => {
        fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { rigour: { command: 'npx', args: ['-y', '@rigour-labs/mcp@6'] }, db: { command: 'db-mcp', args: [] } } }));
        await setupCommand(repo, { team: true, semantic: false });
        expect(mcp()).toEqual({ rigour: resolveMCPServerConfig(), db: { command: 'db-mcp', args: [] } });
    });

    it('leaves an entry the person changed', async () => {
        const own = { command: 'node', args: ['/opt/my-rigour-mcp.js'] };
        fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { rigour: own } }));
        await setupCommand(repo, { team: true, semantic: false });
        expect(mcp().rigour).toEqual(own);
    });

    it('at the same version the hooks pin the CLI to', async () => {
        await setupCommand(repo, { team: true, semantic: false });
        const hook = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command as string;
        const pinned = /@rigour-labs\/cli@(\S+)/.exec(hook)?.[1];
        expect(pinned).toBe(getCliVersion());
        expect(mcpPackageSpec(getCliVersion())).toBe(`@rigour-labs/mcp@${pinned}`);
    });
});

describe('a personal install', () => {
    /** A Claude CLI that answers `mcp get rigour` with `registered`, and logs every call: a .cmd on Windows, as npm installs it there. */
    const fakeClaude = (registered: string) => {
        const log = path.join(root, 'calls.log');
        const windows = process.platform === 'win32';
        const script = path.join(root, windows ? 'claude.cmd' : 'claude');
        fs.writeFileSync(script, windows
            ? `@echo off\r\n>>"${log}" echo %*\r\nif "%1 %2"=="mcp get" (echo ${registered}& exit /b 0)\r\nexit /b 0\r\n`
            : `#!/bin/sh\necho "$@" >> '${log}'\n[ "$1 $2" = "mcp get" ] && { echo '${registered}'; exit 0; }\nexit 0\n`, { mode: 0o755 });
        process.env.RIGOUR_CLAUDE_CLI = script;
        return () => fs.readFileSync(log, 'utf8').replace(/\r/g, '').replace(/ +$/gm, '');
    };
    const server = { command: 'npx', args: ['-y', '@rigour-labs/mcp@6.13.0'] };

    it("moves Rigour's registration at another version to this one", () => {
        const calls = fakeClaude('rigour: npx -y @rigour-labs/mcp@6');
        expect(registerUserMcp(server).claude).toBe('updated');
        expect(calls()).toMatch(/^mcp remove --scope user rigour$/m);
        expect(calls()).toMatch(/^mcp add --scope user rigour -- npx -y @rigour-labs\/mcp@6\.13\.0$/m);
    });

    it('leaves it when it is already this version, or the person changed it', () => {
        const calls = fakeClaude('rigour: npx -y @rigour-labs/mcp@6.13.0');
        expect(registerUserMcp(server).claude).toBe('present');
        fakeClaude('rigour: node /opt/my-rigour-mcp.js');
        expect(registerUserMcp(server).claude).toBe('present');
        expect(calls()).not.toMatch(/mcp (add|remove)/);
    });
});

