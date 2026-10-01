import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reviewAckCommand, reviewExportCommand, reviewTaskCommand } from './review-task.js';

let repo: string;
let out: string[];
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-review-task-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    fs.writeFileSync(path.join(repo, 'sync.ts'), "export async function syncOrders(db, rows) {\n  await db.from('orders').upsert(rows);\n}\n");
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { out.push(args.join(' ')); });
});
afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('review-task, review-ack, review-export', () => {
    it('lists the risky function, records a human review, and exports it', async () => {
        await reviewTaskCommand(repo, { json: true });
        expect(JSON.parse(out.join('\n')).items).toEqual([expect.objectContaining({ file: 'sync.ts', function: 'syncOrders' })]);

        reviewAckCommand(repo, 'sync.ts', 'syncOrders', { verdict: 'no_issue', note: 'rows are one page; key is the order id' });
        expect(out.at(-1)).toContain('Recorded: sync.ts syncOrders (no_issue)');

        out = [];
        await reviewTaskCommand(repo, {});
        expect(out.join('\n')).toContain('No risky changed function waiting for review (1 already reviewed)');

        reviewExportCommand(repo);
        const exported = JSON.parse(fs.readFileSync(path.join(repo, '.rigour', 'reviewed.json'), 'utf8'));
        expect(exported.entries).toEqual([expect.objectContaining({ file: 'sync.ts', function: 'syncOrders', reviewer: 'human', verdict: 'no_issue' })]);
    });

    it('rejects an acknowledgement without a real note, with a failing exit code', () => {
        reviewAckCommand(repo, 'sync.ts', 'syncOrders', { verdict: 'no_issue', note: 'ok' });
        expect(out.at(-1)).toContain('Not recorded: note must say what was checked');
        expect(process.exitCode).toBe(1);
    });
});
