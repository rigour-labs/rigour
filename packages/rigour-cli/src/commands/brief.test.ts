import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readThread } from '@rigour-labs/core';
import { briefCommand, hooksBriefCommand, hooksBriefFileCommand } from './brief.js';
import { hooksInitCommand } from './hooks.js';

let repo: string;
const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
};
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-cli-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'feat/retry']);
    write('AGENTS.md', '- Every job in `src/jobs/` must take `withLock()` before its first read; a job that reads first double-sends.\n');
    write('src/jobs/retry.ts', 'export async function retryJob() {}\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    delete process.env.RIGOUR_BRIEF;
});
afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RIGOUR_BRIEF;
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('the prompt hook', () => {
    const payload = (session: string, prompt = 'make the jobs retry with backoff') => JSON.stringify({ cwd: repo, session_id: session, prompt, hook_event_name: 'UserPromptSubmit' });

    it("briefs from the session's first prompt, once per session, as context Claude Code adds", async () => {
        const reply = JSON.parse(await hooksBriefCommand(payload('s1'), '/'));
        expect(reply.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
        expect(reply.hookSpecificOutput.additionalContext).toContain('1. [must] Every job in `src/jobs/` must take `withLock()`');
        expect(await hooksBriefCommand(payload('s1', 'now add tests'), '/')).toBe(''); // never twice in a session
        expect(await hooksBriefCommand(payload('s2'), '/')).not.toBe(''); // a new session is briefed
        expect(readThread(repo)?.events.map(e => [e.kind, e.session, e.agent])).toEqual([['brief', 's1', 'claude'], ['brief', 's2', 'claude']]);
    });

    it('says nothing when the team or the person switched briefings off, or the payload is not a session', async () => {
        write('rigour.yml', 'version: 1\nbrief:\n  enabled: false\n');
        expect(await hooksBriefCommand(payload('s1'), '/')).toBe('');
        fs.rmSync(path.join(repo, 'rigour.yml'));
        process.env.RIGOUR_BRIEF = '0';
        expect(await hooksBriefCommand(payload('s2'), '/')).toBe('');
        delete process.env.RIGOUR_BRIEF;
        expect(await hooksBriefCommand('not json', '/')).toBe('');
        expect(await hooksBriefCommand(JSON.stringify({ cwd: repo, prompt: 'x' }), '/')).toBe('');
        expect(readThread(repo)?.events ?? []).toEqual([]);
    });

    it('caps the briefing at the max_items the team set', async () => {
        write('AGENTS.md', Array.from({ length: 8 }, (_, i) => `- Every job in \`src/jobs/\` must call \`step${i}()\` before \`retryJob\` reads.\n`).join('\n'));
        write('rigour.yml', 'version: 1\nbrief:\n  max_items: 3\n');
        const text = JSON.parse(await hooksBriefCommand(payload('s3', 'retry job'), '/')).hookSpecificOutput.additionalContext as string;
        expect(text.split('\n').filter(l => /^\d+\. /.test(l))).toHaveLength(3);
    });
});

describe('the edit hook', () => {
    const edit = (session: string, file: string) => JSON.stringify({ cwd: repo, session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, file) } });

    it("gives the team's word on a file the first time a session edits it, once per file per session", async () => {
        const first = JSON.parse(await hooksBriefFileCommand(edit('s1', 'src/jobs/retry.ts'), '/'));
        expect(first.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(first.hookSpecificOutput.additionalContext).toContain('Rigour, before you edit src/jobs/retry.ts');
        expect(first.hookSpecificOutput.additionalContext).toContain('1. [must] Every job in `src/jobs/` must take `withLock()`');
        expect(await hooksBriefFileCommand(edit('s1', 'src/jobs/retry.ts'), '/')).toBe(''); // the same file again
        expect(await hooksBriefFileCommand(edit('s2', 'src/jobs/retry.ts'), '/')).not.toBe(''); // another session
        expect(await hooksBriefFileCommand(edit('s1', 'README.md'), '/')).toBe(''); // nothing applies: nothing said
        expect(readThread(repo)?.events.map(e => [e.kind, e.file, e.session, e.items])).toEqual([['brief', 'src/jobs/retry.ts', 's1', 1], ['brief', 'src/jobs/retry.ts', 's2', 1], ['brief', 'README.md', 's1', 0]]);
    });

    it('says nothing for a file outside the repository, a bad payload, or when briefings are switched off', async () => {
        expect(await hooksBriefFileCommand(JSON.stringify({ cwd: repo, session_id: 's1', tool_input: { file_path: '/etc/hosts' } }), '/')).toBe('');
        expect(await hooksBriefFileCommand('not json', '/')).toBe('');
        expect(await hooksBriefFileCommand(JSON.stringify({ cwd: repo, tool_input: { file_path: 'src/jobs/retry.ts' } }), '/')).toBe('');
        process.env.RIGOUR_BRIEF = 'off';
        expect(await hooksBriefFileCommand(edit('s3', 'src/jobs/retry.ts'), '/')).toBe('');
        delete process.env.RIGOUR_BRIEF;
        write('rigour.yml', 'version: 1\nbrief:\n  enabled: false\n');
        expect(await hooksBriefFileCommand(edit('s4', 'src/jobs/retry.ts'), '/')).toBe('');
        expect(readThread(repo)?.events ?? []).toEqual([]);
    });
});

describe('rigour brief', () => {
    it('prints the briefing as JSON for a goal and files', async () => {
        const out: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
        expect(await briefCommand(repo, 'retry', { files: 'src/jobs/retry.ts', json: true })).toBe(0);
        expect(JSON.parse(out.join('\n'))).toMatchObject({ goal: 'retry', files: ['src/jobs/retry.ts'], items: [{ kind: 'rule', requirement: true, cite: 'AGENTS.md' }] });
    });
});

describe('rigour hooks init --brief', () => {
    it('installs the prompt hook only when asked', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        await hooksInitCommand(repo, { tool: 'claude' });
        const plain = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).hooks;
        expect(plain.UserPromptSubmit).toBeUndefined();
        expect(plain.PreToolUse.some((h: any) => h.matcher === 'Write|Edit|MultiEdit')).toBe(false);
        await hooksInitCommand(repo, { tool: 'claude', brief: true, force: true });
        const hook = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).hooks.UserPromptSubmit;
        expect(hook[0].hooks[0].command).toMatch(/ brief$/);
        expect(hook[0].hooks[0].timeout).toBe(20);
        const edits = JSON.parse(fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.find((h: any) => h.matcher === 'Write|Edit|MultiEdit');
        expect(edits.hooks[0].command).toMatch(/ brief-file$/);
    });
});
