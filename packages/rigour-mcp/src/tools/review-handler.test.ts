import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '@rigour-labs/core';
import { handleReview, handleReviewAck } from './review-handler.js';

const LEAKY = "export async function notify(endpoint: string, signature: string) {\n  return fetch(endpoint, { method: 'POST', headers: { 'x-hook-signature': signature } });\n}\n";

describe('rigour_review', () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    const config = ConfigSchema.parse({ version: 1, gates: { semantic_bugs: { enabled: true }, unused_exports: { enabled: false }, orphan_files: { enabled: false } } });

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-review-'));
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
        git('add', '-A');
        git('commit', '-qm', 'init');
    });
    afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

    it('reviews the uncommitted work without being given a diff', async () => {
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/notify.ts'), LEAKY);
        const payload = JSON.parse((await handleReview(config, repo, {})).content[0].text);
        expect(payload.status).toBe('FAIL');
        expect(payload.failures).toContainEqual(expect.objectContaining({ id: 'semantic-bugs', file: 'src/notify.ts', line: 2 }));
        expect(payload.next_step).toContain('call rigour_review again');
    });

    it('passes a clean working tree', async () => {
        const payload = JSON.parse((await handleReview(config, repo, {})).content[0].text);
        expect(payload).toMatchObject({ status: 'PASS', failures: [], changed_files: 0 });
    });

    it('in agent mode, hands the agent the risky functions to review, until it acknowledges them', async () => {
        fs.mkdirSync(path.join(repo, 'src'));
        fs.writeFileSync(path.join(repo, 'src/sync.ts'), "export async function syncOrders(db, rows) {\n  await db.from('orders').upsert(rows);\n}\n");
        const first = JSON.parse((await handleReview(config, repo, { mode: 'agent' })).content[0].text);
        expect(first.review_task.items).toEqual([expect.objectContaining({ file: 'src/sync.ts', function: 'syncOrders' })]);
        expect(first.next_step).toContain('rigour_review_ack');
        expect(first.quality_receipt).toMatchObject({ functions: 1, reviewed: 0, not_covered: [expect.objectContaining({ function: 'syncOrders', line: 1 })] });

        const refused = handleReviewAck(repo, { file: 'src/sync.ts', function: 'syncOrders', verdict: 'no_issue', note: 'ok' });
        expect(refused.isError).toBe(true);
        const ack = handleReviewAck(repo, { file: 'src/sync.ts', function: 'syncOrders', verdict: 'no_issue', note: 'rows come from one page; upsert key is the order id' });
        expect(JSON.parse(ack.content[0].text).recorded).toEqual({ file: 'src/sync.ts', function: 'syncOrders', verdict: 'no_issue' });

        const second = JSON.parse((await handleReview(config, repo, { mode: 'agent' })).content[0].text);
        expect(second.review_task).toMatchObject({ items: [], already_reviewed: 1 });
        expect(second.quality_receipt).toMatchObject({ reviewed: 1, not_covered: [], reviewers: { agent: 1 } });
    });

    it('reports a bad base ref as a tool error, not a crash', async () => {
        const result = await handleReview(config, repo, { base: 'no-such-branch' });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0].text).error).toContain('merge-base');
    });
});
