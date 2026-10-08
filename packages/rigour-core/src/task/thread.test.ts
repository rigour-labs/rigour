import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBranchEvent, appendTaskEvent, eventsOfKind, readThread, taskOf, threadsDir, threadText } from './thread.js';

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
    const commit = (subject: string) => {
        fs.appendFileSync(path.join(repo, 'a.ts'), `// ${subject}\n`);
        git('commit', '-qam', subject);
    };

    it('is the ticket the branch names only when its own commits name it too; a version token is never a ticket', () => {
        for (const branch of ['chore/pin-node-22', 'fix/utf-8-decoding', 'feat/http-2-push', 'release-1.4', 'bump/python-3-12']) {
            git('checkout', '-q', 'main');
            git('checkout', '-qb', branch);
            commit(`${branch.split('/').pop()}: bump it`); // the version token in the subject, as people write it
            expect(taskOf(repo)?.key).toBe(`branch:${branch}`);
        }
        git('checkout', '-q', 'main');
        git('checkout', '-qb', 'feat/proj-123-resume-emails');
        expect(taskOf(repo)?.key).toBe('branch:feat/proj-123-resume-emails'); // named by the branch, not yet by a commit
        commit('proj-123 resume emails');
        expect(taskOf(repo)?.key).toBe('branch:feat/proj-123-resume-emails'); // lower case is how versions are written, not tickets
        commit('PROJ-123: resume emails');
        expect(taskOf(repo)).toMatchObject({ key: 'PROJ-123', branch: 'feat/proj-123-resume-emails' });
        git('checkout', '-qb', 'fix-the-thing');
        expect(taskOf(repo)?.key).toBe('branch:fix-the-thing'); // a branch with no ticket in its name
        git('checkout', '-q', '--detach');
        expect(taskOf(repo)).toBeUndefined();
        expect(appendTaskEvent(repo, { kind: 'push', passed: true })).toBeUndefined();
    });

    it("takes the ticket from the pull request's title once a review recorded it, when the commits use another scope", () => {
        git('checkout', '-qb', 'feat/PROJ-7-retry');
        commit('fix(retry): back off on 429');
        appendTaskEvent(repo, { kind: 'edit-check', files: ['src/retry.ts'], findings: 0 });
        expect(taskOf(repo)?.key).toBe('branch:feat/PROJ-7-retry');
        appendTaskEvent(repo, { kind: 'review', pr: 7, pr_title: 'feat(PROJ-7): retry with backoff', outcome: 'passed', blocking: 0 });
        expect(taskOf(repo)?.key).toBe('PROJ-7'); // the same commit: the title confirmed it, and the kept task was dropped
        appendTaskEvent(repo, { kind: 'push', passed: true });
        expect(readThread(repo, 'PROJ-7')?.events.map(e => [e.kind, e.task])).toEqual([['edit-check', 'branch:feat/PROJ-7-retry'], ['review', 'branch:feat/PROJ-7-retry'], ['push', 'PROJ-7']]);
    });

    it('works the task out once per commit and keeps it, so the edit hook does not read the branch history on every edit', () => {
        git('checkout', '-qb', 'feat/PROJ-9-cache');
        commit('PROJ-9: start');
        expect(taskOf(repo)?.key).toBe('PROJ-9');
        const cache = path.join(repo, '.git', 'rigour', 'task-cache.json');
        expect(JSON.parse(fs.readFileSync(cache, 'utf8'))['feat/PROJ-9-cache']).toEqual({ head: git('rev-parse', 'HEAD'), key: 'PROJ-9' });
        fs.writeFileSync(cache, JSON.stringify({ 'feat/PROJ-9-cache': { head: git('rev-parse', 'HEAD'), key: 'KEPT-1' } }));
        expect(taskOf(repo)?.key).toBe('KEPT-1'); // read from what was kept, not worked out again
        commit('PROJ-9: more');
        expect(taskOf(repo)?.key).toBe('PROJ-9'); // a new commit: worked out again
    });

    it('keeps one file per exact branch: a/b and a_b never share a thread', () => {
        git('checkout', '-qb', 'feat/a/b');
        appendTaskEvent(repo, { kind: 'push', passed: true });
        git('checkout', '-q', 'main');
        git('checkout', '-qb', 'feat/a_b');
        appendTaskEvent(repo, { kind: 'push', passed: false, failed: 2 });
        expect(readThread(repo, 'feat/a/b')?.events.map(e => [e.branch, e.passed])).toEqual([['feat/a/b', true]]);
        expect(readThread(repo, 'feat/a_b')?.events.map(e => [e.branch, e.passed])).toEqual([['feat/a_b', false]]);
        expect(fs.readdirSync(threadsDir(repo)!)).toHaveLength(2);
    });

    it('gathers a ticket across the branches and worktrees that worked on it, from their first event', () => {
        git('checkout', '-qb', 'feat/PROJ-5-api');
        appendTaskEvent(repo, { kind: 'edit-check', files: ['src/api.ts'], findings: 1 }); // before the first commit names the ticket
        commit('PROJ-5: the api');
        appendTaskEvent(repo, { kind: 'push', passed: true });
        const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thread-wt-')), 'wt');
        git('worktree', 'add', '-q', '-b', 'feat/PROJ-5-ui', other, 'main');
        fs.appendFileSync(path.join(other, 'a.ts'), '// ui\n');
        execFileSync('git', ['-C', other, 'commit', '-qam', 'PROJ-5 the ui'], { encoding: 'utf8' });
        appendTaskEvent(other, { kind: 'push', passed: true }); // written from the other worktree, into the same folder
        const thread = readThread(repo, 'proj-5');
        expect(thread?.task).toBe('PROJ-5');
        expect(thread?.events.map(e => [e.kind, e.branch])).toEqual([['edit-check', 'feat/PROJ-5-api'], ['push', 'feat/PROJ-5-api'], ['push', 'feat/PROJ-5-ui']]);
        expect(readThread(repo, 'feat/PROJ-5-ui')?.events).toHaveLength(1);
        git('worktree', 'remove', '--force', other);
    });

    it('keeps an append-only thread, read by ticket, branch, pull request or the checkout, oldest first, skipping a broken line', () => {
        git('checkout', '-qb', 'feat/PROJ-7-retry');
        commit('PROJ-7 retry');
        appendTaskEvent(repo, { kind: 'edit-check', session: 'sess-aaaa1111', agent: 'claude', files: ['src/job.ts'], findings: 2 });
        appendTaskEvent(repo, { kind: 'edit-check', session: 'sess-aaaa1111', agent: 'claude', files: ['src/job.ts'], findings: 0 });
        appendTaskEvent(repo, { kind: 'stop-review', session: 'sess-aaaa1111', agent: 'claude', blocked: true, blocking: 1 });
        appendTaskEvent(repo, { kind: 'push', passed: false, failed: 1 });
        appendTaskEvent(repo, { kind: 'push', passed: true, failed: 0 });
        appendTaskEvent(repo, { kind: 'review', pr: 42, outcome: 'passed', blocking: 0, should_fix: 1, integrity: 'abcdef0123456789abcdef' });
        const [name] = fs.readdirSync(threadsDir(repo)!);
        const file = path.join(threadsDir(repo)!, name);
        expect(name).toMatch(/^feat_PROJ-7-retry-[0-9a-f]{8}\.jsonl$/);
        expect(fs.realpathSync(file)).toBe(fs.realpathSync(path.join(repo, '.git', 'rigour', 'threads', name)));
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

describe('events across threads', () => {
    it('reads one kind from every branch\'s thread, oldest first, and writes to a named branch only when it has a thread', () => {
        git('checkout', '-qb', 'one');
        appendTaskEvent(repo, { kind: 'review', pr: 1, lessons_applied: ['L1'] });
        git('checkout', '-qb', 'two');
        appendTaskEvent(repo, { kind: 'push', passed: true });
        appendTaskEvent(repo, { kind: 'review', pr: 2 });
        expect(eventsOfKind(repo, 'review').map(e => [e.branch, e.pr])).toEqual([['one', 1], ['two', 2]]);
        expect(appendBranchEvent(repo, 'one', { kind: 'merge', pr: 1 })?.task).toBe('branch:one');
        expect(appendBranchEvent(repo, 'never-here', { kind: 'merge', pr: 9 })).toBeUndefined();
        expect(eventsOfKind(repo, 'merge').map(e => e.pr)).toEqual([1]);
    });
});
