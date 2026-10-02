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
const byId = (id: string) => checkRepoSetup(cwd, now).find(c => c.id === id)!;

describe('checkRepoSetup', () => {
    it('says working only when the hook fired this week, not because a file exists', () => {
        write('.claude/settings.json', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ command: 'rigour hooks check --stdin' }] }] } }));
        expect(byId('edit')).toMatchObject({ state: 'set up', detail: 'Configured; has not fired here yet' });
        write('.rigour/events.jsonl', JSON.stringify({ type: 'hook_check', timestamp: '2026-10-09T11:50:00Z' }) + '\n');
        expect(byId('edit')).toMatchObject({ state: 'working', detail: '1 edit check this week · last 10 min ago' });
    });

    it('calls out the old hook that checked nothing', () => {
        write('.claude/settings.json', 'rigour hooks check --files "$TOOL_INPUT_file_path"');
        expect(byId('edit')).toMatchObject({ state: 'broken', fix: 'rigour hooks init --force' });
    });

    it('finds the PR workflow and reports what is missing', () => {
        expect(byId('pr').state).toBe('missing');
        expect(byId('config').state).toBe('missing');
        write('.github/workflows/review.yml', 'steps:\n  - uses: rigour-labs/rigour@v6\n');
        expect(byId('pr')).toMatchObject({ state: 'set up', detail: '.github/workflows/review.yml' });
    });

    it('counts what agents did in every worktree of the repository', () => {
        const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
        const tree = path.join(cwd, 'wt');
        git('worktree', 'add', '-q', tree);
        write('.claude/settings.json', 'rigour hooks check --stdin; rigour hooks stop --tool claude');
        fs.mkdirSync(path.join(tree, '.rigour'));
        fs.writeFileSync(path.join(tree, '.rigour', 'events.jsonl'), JSON.stringify({ type: 'stop_review', timestamp: '2026-10-09T11:00:00Z' }) + '\n');
        expect(byId('stop')).toMatchObject({ state: 'working', detail: '1 finish check this week · last 1 h ago' });
    });
});
