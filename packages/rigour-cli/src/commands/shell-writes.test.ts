import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseStdinFiles } from './hooks.js';

/** The built CLI, as the agent's hooks run it. */
const bin = path.resolve(__dirname, '../../dist/bin.js');
let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

/** Claude Code's hook payload for a Bash call, before (PreToolUse) or after it ran (PostToolUse). */
function payload(event: 'PreToolUse' | 'PostToolUse', command: string, id: string): string {
    return JSON.stringify({
        session_id: 'sess-1', transcript_path: path.join(home, 'transcript.jsonl'), cwd: repo, permission_mode: 'default',
        hook_event_name: event, tool_name: 'Bash', tool_input: { command, description: 'runs it' }, tool_use_id: id,
        ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false } } : {}),
    });
}

/** The hook pair around one shell call, as Claude Code runs them, with `effect` standing in for the command itself. */
function shellCall(command: string, id: string, effect: () => void) {
    const env = { ...process.env, HOME: home, RIGOUR_HOME: home, RIGOUR_AGENT_HOME: home, RIGOUR_TELEMETRY: '0' };
    spawnSync(process.execPath, [bin, 'hooks', 'push', '--stdin'], { cwd: repo, input: payload('PreToolUse', command, id), env, encoding: 'utf8' });
    effect();
    return spawnSync(process.execPath, [bin, 'hooks', 'check', '--stdin', '--block'], { cwd: repo, input: payload('PostToolUse', command, id), env, encoding: 'utf8' });
}

beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-writes-')));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-writes-home-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/main.go'), 'package main\n\nfunc main() {\n}\n');
    fs.writeFileSync(path.join(repo, 'rigour.yml'), 'version: 1\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('the edit check sees what a shell command wrote', () => {
    it('blocks a heredoc that writes a broken import, with the same message as an Edit', () => {
        const run = shellCall("cat > src/util.ts <<'EOF'\nimport { gone } from './missing';\nexport const a = gone;\nEOF", 'toolu_heredoc', () => {
            fs.writeFileSync(path.join(repo, 'src/util.ts'), "import { gone } from './missing';\nexport const a = gone;\n");
        });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain(`[rigour/hallucinated-imports] ${path.join('src', 'util.ts')}:1: Import './missing' does not resolve to an existing file`);
    });

    it('says nothing about a formatter rewriting a file with no new problem', () => {
        const run = shellCall('gofmt -w src/main.go', 'toolu_gofmt', () => {
            fs.writeFileSync(path.join(repo, 'src/main.go'), 'package main\n\nfunc main() {}\n');
        });
        expect(run.status).toBe(0);
        expect(run.stderr).not.toContain('[rigour/');
    });

    it('is silent for a shell call that writes nothing', () => {
        const run = shellCall('ls -la', 'toolu_ls', () => undefined);
        expect(run.status).toBe(0);
        expect(run.stdout).toBe('');
        expect(run.stderr).toBe('');
    });
});

describe('the edit check on a notebook', () => {
    it("reads NotebookEdit's notebook_path", () => {
        expect(parseStdinFiles(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/r/analysis.ipynb', new_source: 'x = 1' } }))).toEqual(['/r/analysis.ipynb']);
    });
});
