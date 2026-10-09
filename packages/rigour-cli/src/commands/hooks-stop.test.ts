import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readThread, recordSessionBaseline } from '@rigour-labs/core';
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

    // Built once and copied into each test's own folder: every git command is a process, slow to start on Windows.
    let fixture: string;
    beforeAll(() => {
        repo = fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-fixture-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        write('rigour.yml', 'version: 1\ngates:\n  semantic_bugs:\n    enabled: true\n  unused_exports:\n    block: true\n'); // this team blocks on dead code
        write('.gitignore', '.rigour/\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
    });
    afterAll(() => { fs.rmSync(fixture, { recursive: true, force: true }); });
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
        fs.cpSync(fixture, repo, { recursive: true });
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks(); });

    it('keeps Claude working on a proven finding, then gives up after three attempts', async () => {
        write('src/notify.ts', LEAKY);
        const payload = JSON.stringify({ cwd: repo, session_id: 's1' });
        const first = JSON.parse(await hooksStopCommand('claude', payload, '/'));
        expect(first.decision).toBe('block');
        expect(first.reason).toContain('src/notify.ts:2');
        expect(first.reason).toContain('attempt 1 of 3');
        // The task's thread keeps the blocked stop review, with the agent and its session.
        expect(readThread(repo)?.events.map(e => [e.kind, e.agent, e.session, e.blocked])).toEqual([['stop-review', 'claude', 's1', true]]);
        for (const n of [1, 2]) {
            write('src/notify.ts', `${LEAKY}// attempt ${n}\n`); // the agent edits, still leaking
            await hooksStopCommand('claude', payload, '/');
        }
        write('src/notify.ts', `${LEAKY}// attempt 3\n`);
        expect(await hooksStopCommand('claude', payload, '/')).toBe('');
    }, process.platform === 'win32' ? 90_000 : 30_000); // four whole stop reviews: Windows runners took past 30 s

    it('sends Cursor a follow-up message, and stops following up at the loop limit', async () => {
        write('src/notify.ts', LEAKY);
        const reply = JSON.parse(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'completed', loop_count: 0 }), '/'));
        expect(reply.followup_message).toContain('src/notify.ts:2');
        expect(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'completed', loop_count: 3 }), '/')).toBe('');
        expect(await hooksStopCommand('cursor', JSON.stringify({ cwd: repo, status: 'aborted' }), '/')).toBe('');
    });

    it('asks once, at the end of the task, about what the team learned that applies to the change', async () => {
        const lesson = { id: 'l1', text: 'Time out every fetch the loader makes.', file: 'src/load.ts', symbols: ['load'], state: 'verified', evidence: [{ pr: 7, comment: 'c1', author: 'senior' }, { pr: 9, comment: 'c2', author: 'senior' }], createdAt: '2026-01-01', updatedAt: '2026-01-01' };
        write('.rigour/review-lessons.json', JSON.stringify({ version: 1, lessons: [lesson, { ...lesson, id: 'l2', text: 'Unrelated lesson about billing.', file: 'src/billing.ts', symbols: ['charge'] }] }));
        write('src/load.ts', HEURISTIC);
        write('src/main.ts', "import { load } from './load';\nvoid load('/');\n");
        const payload = JSON.stringify({ cwd: repo, session_id: 'teach' });
        const first = JSON.parse(await hooksStopCommand('claude', payload, '/'));
        expect(first.decision).toBe('block');
        expect(first.reason).toContain('src/load.ts: Time out every fetch the loader makes. (acted on in PR #7, #9)');
        expect(first.reason).not.toContain('billing');
        write('src/load.ts', `${HEURISTIC}// the agent checked it\n`);
        expect(await hooksStopCommand('claude', payload, '/')).toBe(''); // asked once: never a loop
    });

    it('lets the agent stop when only heuristic findings remain', async () => {
        write('src/load.ts', HEURISTIC);
        write('src/main.ts', "import { load } from './load';\nvoid load('/');\n");
        write('package.json', '{"scripts":{"start":"node src/main.ts"}}\n'); // wired in: not dead code
        expect(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 's2' }), '/')).toBe('');
    });

    it('says once when the review cannot run, then lets the agent stop', async () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-norepo-'));
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const payload = JSON.stringify({ cwd: notARepo, session_id: 'broken' });
        const first = JSON.parse(await hooksStopCommand('claude', payload, '/'));
        expect(first).toMatchObject({ decision: 'block' });
        expect(first.reason).toContain('Rigour could not review this change');
        expect(await hooksStopCommand('claude', payload, '/')).toBe('');
        fs.rmSync(notARepo, { recursive: true, force: true });
    });

    it('still reviews what the session committed', async () => {
        recordSessionBaseline(repo, 's3');
        write('src/notify.ts', LEAKY);
        git('add', '-A');
        git('commit', '-qm', 'hide it in a commit');
        const reply = JSON.parse(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 's3' }), '/'));
        expect(reply.reason).toContain('src/notify.ts:2');
    });

    it('reviews the whole branch, including commits made before the session started', async () => {
        git('checkout', '-q', '-b', 'feature');
        write('src/notify.ts', LEAKY);
        git('add', '-A');
        git('commit', '-qm', 'earlier work on the branch');
        const reply = JSON.parse(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 'branch' }), '/'));
        expect(reply.reason).toContain('src/notify.ts:2');
    });

    it('says there was nothing to review instead of passing silently', async () => {
        git('checkout', '-q', '-b', 'empty');
        const said: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { said.push(String(chunk)); return true; });
        expect(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 'empty' }), '/')).toBe('');
        expect(said.join('')).toContain('nothing to review against main @');
    });

    it('holds the agent back on an export the branch added that nothing uses', async () => {
        git('checkout', '-q', '-b', 'dead');
        write('src/util.ts', 'export const used = 1;\nexport const forgotten = 2;\n');
        write('src/main.ts', "import { used } from './util';\nconsole.log(used);\n");
        const reply = JSON.parse(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 'dead' }), '/'));
        expect(reply.reason).toContain('src/util.ts:2 Unused export');
    });

    it('does not repeat itself after a turn that changed nothing, and reviews again after an edit', async () => {
        write('src/notify.ts', LEAKY);
        const payload = JSON.stringify({ cwd: repo, session_id: 'quiet' });
        expect(JSON.parse(await hooksStopCommand('claude', payload, '/')).decision).toBe('block');
        expect(await hooksStopCommand('claude', payload, '/')).toBe(''); // a read-only turn: already said
        write('src/notify.ts', LEAKY + '// touched\n');
        expect(JSON.parse(await hooksStopCommand('claude', payload, '/')).decision).toBe('block');
    });

    it("does not count Rigour's own files as new work where the repository does not ignore them", async () => {
        write('.gitignore', ''); // a repository that does not ignore .rigour/ or the report
        git('add', '-A');
        git('commit', '-qm', 'ignore nothing');
        write('src/notify.ts', LEAKY);
        const payload = JSON.stringify({ cwd: repo, session_id: 'own-files' });
        expect(JSON.parse(await hooksStopCommand('claude', payload, '/')).decision).toBe('block');
        write('rigour-report.json', '{"rewritten":true}\n'); // what a review leaves behind
        write('.rigour/scan-cache.json', '{}\n');
        expect(await hooksStopCommand('claude', payload, '/')).toBe('');
    });

    it('ignores an attempt counter written into the workspace', async () => {
        write('.rigour/stop-hook.json', JSON.stringify({ s4: 3 }));
        write('src/notify.ts', LEAKY);
        const reply = JSON.parse(await hooksStopCommand('claude', JSON.stringify({ cwd: repo, session_id: 's4' }), '/'));
        expect(reply.reason).toContain('attempt 1 of 3');
    });
});

describe('the agent fix loop', () => {
    it('turns an agent fix to a stop-hook finding into a validated rule', async () => {
        const { learnCommand } = await import('./learn.js');
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
        const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(repo, '.gitignore'), '.rigour/\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/notify.ts'), LEAKY);
        fs.writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"notify":"node src/notify.ts"}}\n'); // wired in: not dead code

        const payload = JSON.stringify({ cwd: repo, session_id: 'loop' });
        expect(JSON.parse(await hooksStopCommand('claude', payload, '/')).decision).toBe('block');
        fs.writeFileSync(path.join(repo, 'src/notify.ts'), LEAKY.replace("{ method: 'POST',", "{ method: 'POST', redirect: 'manual',"));
        expect(await hooksStopCommand('claude', payload, '/')).toBe('');

        vi.spyOn(console, 'log').mockImplementation(() => {});
        await learnCommand(repo, undefined, { agentFixes: true });
        const rules = fs.readdirSync(path.join(repo, '.rigour', 'rules'));
        expect(rules).toHaveLength(1);
        expect(JSON.parse(fs.readFileSync(path.join(repo, '.rigour', 'rules', rules[0]), 'utf8')).pattern)
            .toMatchObject({ template: 'require-option', property: 'redirect', value: 'manual' });
        expect(fs.readdirSync(path.join(repo, '.rigour', 'agent-fixes', 'resolved'))).toEqual([]);
        fs.rmSync(repo, { recursive: true, force: true });
    });
});
