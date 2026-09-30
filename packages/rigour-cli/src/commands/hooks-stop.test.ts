import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hooksStopCommand } from './hooks-stop.js';

// A credential header on a redirect-following request: a proven (verified) high finding.
const LEAKY = "export async function notify(endpoint: string, signature: string) {\n  return fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } });\n}\n";
// Only a heuristic finding (fetch without error handling), not proven.
const HEURISTIC = "export async function load(url: string) {\n  return fetch(url);\n}\n";

describe('rigour hooks stop', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('rigour.yml', 'version: 1\ngates:\n  semantic_bugs:\n    enabled: true\n');
        write('.gitignore', '.rigour/\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks(); });

    it('keeps Claude working on a proven finding, then gives up after three attempts', async () => {
        write('src/notify.ts', LEAKY);
        const payload = JSON.stringify({ cwd: repo, session_id: 's1' });
        const first = JSON.parse(await hooksStopCommand('claude', payload, '/'));
        expect(first.decision).toBe('block');
        expect(first.reason).toContain('src/notify.ts:2');
        expect(first.reason).toContain('attempt 1 of 3');
        await hooksStopCommand('claude', payload, '/');
        await hooksStopCommand('claude', payload, '/');
        expect(await hooksStopCommand('claude', payload, '/')).toBe('');
    });

    it('sends Cursor a follow-up message, and stops following up at the loop limit', async () => {
        write('src/notify.ts', LEAKY);
        const reply = JSON.parse(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'completed', loop_count: 0 }), '/'));
        expect(reply.followup_message).toContain('src/notify.ts:2');
        expect(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'completed', loop_count: 3 }), '/')).toBe('');
        expect(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'aborted' }), '/')).toBe('');
    });

    it('lets the agent stop when only heuristic findings remain', async () => {
        write('src/load.ts', HEURISTIC);
        expect(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 's2' }), '/')).toBe('');
    });

    it('lets the agent stop when the review cannot run', async () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-norepo-'));
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        expect(await hooksStopCommand('claude', JSON.stringify({ cwd: notARepo }), '/')).toBe('');
        expect(String(stderr.mock.calls[0]?.[0])).toContain('Rigour stop review skipped');
        fs.rmSync(notARepo, { recursive: true, force: true });
    });
});
