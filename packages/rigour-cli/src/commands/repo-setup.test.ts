import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRepoSetup } from './repo-setup.js';

let cwd: string;
const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), body); };
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));
const now = new Date('2026-10-09T12:00:00Z');
const byId = async (id: string) => (await checkRepoSetup(cwd, now, [])).find(c => c.id === id)!;

describe('checkRepoSetup', () => {
    it('says working only when the hook fired this week, not because a file exists', async () => {
        write('.claude/settings.json', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'rigour hooks check --stdin' }] }] } }));
        expect(await byId('edit')).toMatchObject({ state: 'set up', detail: 'Configured; has not fired here yet' });
        write('.rigour/events.jsonl', JSON.stringify({ type: 'hook_check', timestamp: '2026-10-09T11:50:00Z' }) + '\n');
        expect(await byId('edit')).toMatchObject({ state: 'working', detail: '1 edit check this week · last 10 min ago' });
    });

    it('calls out the old hook that checked nothing', async () => {
        write('.claude/settings.json', 'rigour hooks check --files "$TOOL_INPUT_file_path"');
        expect(await byId('edit')).toMatchObject({ state: 'broken', fix: 'rigour setup' }); // setup migrates a personal install too
    });

    it('says when the agent hooks or the MCP server run another Rigour than the one installed', async () => {
        const version = async () => (await checkRepoSetup(cwd, now, [], '6.13.0')).find(c => c.id === 'version');
        expect(await version()).toBeUndefined(); // nothing pins a version: nothing to say
        write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'npx --yes @rigour-labs/cli@6.13.0 hooks stop --tool claude' }] }] } }));
        write('.mcp.json', JSON.stringify({ mcpServers: { rigour: { command: 'npx', args: ['-y', '@rigour-labs/mcp@6.13.0'] } } }));
        expect(await version()).toMatchObject({ state: 'working', detail: '6.13.0' });
        write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'npx --yes @rigour-labs/cli@6.12.4 hooks stop --tool claude' }] }] } }));
        write('.mcp.json', JSON.stringify({ mcpServers: { rigour: { command: 'npx', args: ['-y', '@rigour-labs/mcp@6'] } } }));
        expect(await version()).toMatchObject({ state: 'broken', detail: 'hooks run 6.12.4, the MCP server floats on @6; installed is 6.13.0', fix: 'rigour setup' });
    });

    it('finds the PR workflow and reports what is missing', async () => {
        expect((await byId('pr')).state).toBe('missing');
        expect((await byId('config')).state).toBe('missing');
        write('.github/workflows/review.yml', 'steps:\n  - uses: rigour-labs/rigour@v6\n');
        expect(await byId('pr')).toMatchObject({ state: 'set up', detail: '.github/workflows/review.yml' });
    });

    it('counts what agents did in every worktree of the repository', async () => {
        const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
        const tree = path.join(cwd, 'wt');
        git('worktree', 'add', '-q', tree);
        write('.claude/settings.json', 'rigour hooks check --stdin; rigour hooks stop --tool claude');
        fs.mkdirSync(path.join(tree, '.rigour'));
        fs.writeFileSync(path.join(tree, '.rigour', 'events.jsonl'), JSON.stringify({ type: 'stop_review', timestamp: '2026-10-09T11:00:00Z' }) + '\n');
        expect(await byId('stop')).toMatchObject({ state: 'working', detail: '1 finish check this week · last 1 h ago' });
    });

    it("counts the MCP server's tool calls, not the CLI's own events", async () => {
        write('.rigour/events.jsonl', JSON.stringify({ type: 'tool_call', tool: 'rigour_init', timestamp: '2026-10-09T11:00:00Z' }) + '\n');
        expect((await checkRepoSetup(cwd, now, [])).find(c => c.id === 'mcp')!.state).toBe('missing');
        const call = { toolName: 'rigour_review', cacheStatus: 'none' as const, candidateTokens: 0, returnedTokens: 0, createdAt: Date.parse('2026-10-09T11:30:00Z') };
        expect((await checkRepoSetup(cwd, now, [call])).find(c => c.id === 'mcp')).toMatchObject({ state: 'working', detail: '1 tool call this week · last 30 min ago' });
    });
});
