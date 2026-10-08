import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendTaskEvent, readThread, taskOf, threadsDir, threadText } from './thread.js';

let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('the engineering task', () => {
    it('is the ticket the branch names, else the branch, and nothing on a detached head; one thread across worktrees', () => {
        git('checkout', '-qb', 'feat/proj-123-resume-emails');
        expect(taskOf(repo)).toMatchObject({ key: 'PROJ-123', branch: 'feat/proj-123-resume-emails' });
        git('checkout', '-qb', 'fix-the-thing');
        expect(taskOf(repo)?.key).toBe('branch:fix-the-thing');
        const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thread-wt-')), 'wt');
        git('worktree', 'add', '-q', '-b', 'feat/proj-123-more', other);
        // One repository, one set of threads: an event from the other worktree lands in the same folder.
        appendTaskEvent(other, { kind: 'push', passed: true });
        expect(readThread(repo, 'PROJ-123')?.events.map(e => e.branch)).toEqual(['feat/proj-123-more']);
        git('worktree', 'remove', '--force', other);
        git('checkout', '-q', '--detach');
        expect(taskOf(repo)).toBeUndefined();
        expect(appendTaskEvent(repo, { kind: 'push', passed: true })).toBeUndefined();
    });

    it('keeps an append-only thread, read by ticket, branch, pull request or the checkout, oldest first, skipping a broken line', () => {
        git('checkout', '-qb', 'feat/PROJ-7-retry');
        appendTaskEvent(repo, { kind: 'edit-check', session: 'sess-aaaa1111', agent: 'claude', files: ['src/job.ts'], findings: 2 });
        appendTaskEvent(repo, { kind: 'edit-check', session: 'sess-aaaa1111', agent: 'claude', files: ['src/job.ts'], findings: 0 });
        appendTaskEvent(repo, { kind: 'stop-review', session: 'sess-aaaa1111', agent: 'claude', blocked: true, blocking: 1 });
        appendTaskEvent(repo, { kind: 'push', passed: false, failed: 1 });
        appendTaskEvent(repo, { kind: 'push', passed: true, failed: 0 });
        appendTaskEvent(repo, { kind: 'review', pr: 42, outcome: 'passed', blocking: 0, should_fix: 1, integrity: 'abcdef0123456789abcdef' });
        const file = path.join(threadsDir(repo)!, 'PROJ-7.jsonl');
        expect(fs.realpathSync(file)).toBe(fs.realpathSync(path.join(repo, '.git', 'rigour', 'threads', 'PROJ-7.jsonl')));
        expect(git('status', '--porcelain')).toBe(''); // nothing in the working tree
        fs.appendFileSync(file, 'not json\n{"kind":"push"}\n');
        const byTicket = readThread(repo, 'proj-7');
        expect(byTicket?.task).toBe('PROJ-7');
        expect(byTicket?.events.map(e => e.kind)).toEqual(['edit-check', 'edit-check', 'stop-review', 'push', 'push', 'review']);
        expect(readThread(repo, 'feat/PROJ-7-retry')?.events).toHaveLength(6);
        expect(readThread(repo, '#42')?.task).toBe('PROJ-7');
        expect(readThread(repo, '42')?.task).toBe('PROJ-7');
        expect(readThread(repo)?.events).toHaveLength(6);
        expect(readThread(repo, '#43')).toBeUndefined();
        expect(readThread(repo, 'OTHER-1')).toBeUndefined();
        expect(byTicket!.events[0]).toMatchObject({ task: 'PROJ-7', branch: 'feat/PROJ-7-retry', head: git('rev-parse', 'HEAD') });

        const text = threadText(byTicket!).join('\n');
        expect(text).toContain('PROJ-7 · feat/PROJ-7-retry · PR #42');
        expect(text).toContain('1 agent session(s) (claude)');
        expect(text).toContain('findings caught while writing: 2, files clean again after a finding: 1');
        expect(text).toContain('stop reviews: 1, blocked: 1');
        expect(text).toContain('pushes: 2, blocked: 1');
        expect(text).toContain('reviews: 1, last: passed with 0 blocking (record abcdef0123456789)');
        expect(text).toContain('blocked: 1 check(s) failed');
    });

    it('never fails the hook it runs in: an unwritable thread folder is skipped', () => {
        git('checkout', '-qb', 'feat/PROJ-8');
        fs.writeFileSync(path.join(repo, '.git', 'rigour'), 'a file where the folder should be');
        expect(appendTaskEvent(repo, { kind: 'push', passed: true })).toBeUndefined();
        expect(readThread(repo)?.events ?? []).toEqual([]);
        expect(threadText({ task: 'PROJ-8', events: [] })).toEqual(['PROJ-8: nothing recorded yet']);
    });
});
