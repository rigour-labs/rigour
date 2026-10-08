import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendTaskEvent } from '@rigour-labs/core';
import { threadCommand } from './thread.js';

let repo: string;
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-cli-'));
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'feat/PROJ-9-thing']);
});
afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('rigour thread', () => {
    it('prints the thread, as text or JSON, and exits 1 with a reason when there is none', () => {
        const out: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
        vi.spyOn(console, 'error').mockImplementation((line: unknown) => void out.push(String(line)));
        expect(threadCommand(repo, 'feat/PROJ-9-thing', {})).toBe(1);
        expect(out.join('\n')).toContain('no thread for feat/PROJ-9-thing');
        appendTaskEvent(repo, { kind: 'push', passed: true, failed: 0 });
        out.length = 0;
        expect(threadCommand(repo, undefined, {})).toBe(0);
        expect(out[0]).toContain('branch:feat/PROJ-9-thing'); // no commit names the ticket yet
        out.length = 0;
        expect(threadCommand(repo, 'feat/PROJ-9-thing', { json: true })).toBe(0);
        expect(JSON.parse(out.join('\n'))).toMatchObject({ task: 'branch:feat/PROJ-9-thing', events: [{ kind: 'push', passed: true }] });
    });
});
