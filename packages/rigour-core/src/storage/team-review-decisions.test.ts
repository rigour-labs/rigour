import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewLesson } from '../review-learning/lessons.js';
import { decisionRows, pushReviewDecisions, type DecisionCache, type DecisionPool } from './team-review-decisions.js';

const ME = 'lead@example.com';
const lesson = (extra: Partial<ReviewLesson> = {}): ReviewLesson => ({
    id: 'a1b2c3d4e5f6', text: 'Use an upsert keyed on the order id so retries do not duplicate orders.', file: 'src/orders/write.ts', symbols: ['saveOrder'],
    state: 'verified', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    evidence: [
        { kind: 'point', pr: 7, comment: '9001', author: 'senior-reviewer', source: 'person', text: 'This inserts twice on a retry.', at: '2026-01-01T00:00:00Z' },
        { kind: 'point', pr: 9, comment: '9002', author: 'review-bot[bot]', source: 'bot', text: 'Consider an upsert.' },
        { kind: 'accepted', pr: 7, comment: 'accepted-2026-01-02T00:00:00Z', author: ME, detail: 'we always upsert', at: '2026-01-02T00:00:00Z' },
    ],
    ...extra,
});
const context = { repositoryId: 'repo-hash', person: ME, salt: 'org-salt' };

describe('which decisions are shared, and what they carry', () => {
    it('shares my decision with the approved wording, the file as a hash and each point without its text or login', () => {
        const [row] = decisionRows([lesson()], context);
        expect(row).toMatchObject({ lessonId: 'a1b2c3d4e5f6', kind: 'accepted', decidedAt: '2026-01-02T00:00:00.000Z', detail: 'we always upsert' });
        expect(row.payload.text).toBe('Use an upsert keyed on the order id so retries do not duplicate orders.');
        expect(row.payload.file).toMatch(/^[0-9a-f]{64}$/);
        expect(row.payload.points.map(p => [p.pr, p.comment, p.source])).toEqual([[7, '9001', 'person'], [9, '9002', 'bot']]);
        const sent = JSON.stringify(row);
        for (const secret of ['src/orders', 'senior-reviewer', 'review-bot', 'inserts twice', 'Consider an upsert', 'saveOrder']) expect(sent).not.toContain(secret);
    });

    it('never sends someone else\'s decision, a correction, or evidence that is not a decision', () => {
        const others = lesson({ evidence: [
            ...lesson().evidence.slice(0, 2),
            { kind: 'accepted', pr: 7, comment: 'accepted-x', author: 'someone@example.com', at: '2026-01-02T00:00:00Z' },
            { kind: 'correction', pr: 0, comment: 'edit-1', author: ME, text: 'In src/a.ts, a person changed: - a + b', at: '2026-01-02T00:00:00Z' },
            { kind: 'lines', pr: 7, comment: 'lines-1', author: '' },
        ] });
        expect(decisionRows([others], context)).toEqual([]);
    });

    it('a rejection carries no wording; a rewording drops the old wording; a scope carries its scope and folder hash', () => {
        const rows = decisionRows([lesson({ evidence: [
            ...lesson().evidence.slice(0, 1),
            { kind: 'rejected', pr: 7, comment: 'rejected-1', author: ME, detail: 'one-off', at: '2026-01-03T00:00:00Z' },
            { kind: 'reworded', pr: 7, comment: 'reworded-1', author: ME, detail: 'clearer; was: the old wording from the review', at: '2026-01-04T00:00:00Z' },
            { kind: 'scoped', pr: 7, comment: 'scoped-1', author: ME, detail: 'folder: all writers', at: '2026-01-05T00:00:00Z' },
        ] })], context);
        expect(rows.map(r => [r.kind, r.payload.text !== undefined, r.detail])).toEqual([['rejected', false, 'one-off'], ['reworded', true, 'clearer'], ['scoped', false, 'folder: all writers']]);
        expect(rows[2].payload).toMatchObject({ scope: 'folder', folder: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(JSON.stringify(rows)).not.toContain('old wording');
    });

    it('a compiled check taken back carries no wording', () => {
        const rows = decisionRows([lesson({ evidence: [
            { kind: 'compiled', pr: 7, comment: 'compiled-c1-a', author: ME, detail: 'approved compiled check c1', at: '2026-01-03T00:00:00Z' },
            { kind: 'compiled', pr: 7, comment: 'compiled-c1-b', author: ME, detail: 'took back compiled check c1', at: '2026-01-04T00:00:00Z' },
        ] })], context);
        expect(rows.map(r => r.payload.text !== undefined)).toEqual([true, false]);
    });

    it('gives the same keys for the same store, and a reviewer a different hash in another organization', () => {
        expect(decisionRows([lesson()], context)[0].clientKey).toBe(decisionRows([lesson()], context)[0].clientKey);
        const here = decisionRows([lesson()], context)[0].payload.points[0].reviewer;
        const there = decisionRows([lesson()], { ...context, salt: 'other-salt' })[0].payload.points[0].reviewer;
        expect(here).not.toBe(there);
    });
});

describe('pushing decisions', () => {
    let repo: string;
    const scope = { organizationId: 'acme', teamId: 'web', actorId: 'jane', repositories: ['github.com/acme/*'] };
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
        fs.mkdirSync(path.join(repo, '.rigour'));
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [lesson()] }));
    });
    afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

    function fakes(role = 'sme', version: string | null = '1', refuse?: string) {
        const inserts: unknown[][] = [];
        const pool: DecisionPool = {
            query: async (sql, params) => {
                if (sql.includes("key = 'review_decisions_version'")) return { rows: version ? [{ value: version }] : [], rowCount: 1 };
                if (sql.includes('FROM rigour.memberships')) return { rows: [{ role, salt: 'org-salt' }], rowCount: 1 };
                if (refuse) throw Object.assign(new Error('refused'), { code: refuse });
                inserts.push(params ?? []);
                return { rows: [], rowCount: 1 };
            },
        };
        const meta = new Map<string, string>();
        const sent = new Map<string, string>();
        const cache: DecisionCache = {
            get: async (_sql, key) => (meta.has(String(key)) ? { value: meta.get(String(key)) } : undefined),
            all: async () => [...sent.keys()].map(client_key => ({ client_key })),
            run: async (sql, ...params) => {
                if (sql.includes('review_decisions_sent')) sent.set(String(params[0]), String(params[2]));
                else meta.set(String(params[0]), String(params[1]));
            },
        };
        return { pool, cache, inserts, sent };
    }
    const input = (extra = {}) => ({ cwd: repo, origin: 'https://github.com/acme/api', repositoryId: 'repo-hash', person: ME, scope, ...extra });

    it('sends each decision once: an unchanged store is not read again, and a sent key is never resent', async () => {
        const f = fakes();
        expect(await pushReviewDecisions(f.pool, f.cache, input())).toEqual({ sent: 1, refused: 0 });
        expect(await pushReviewDecisions(f.pool, f.cache, input())).toEqual({ sent: 0, refused: 0 });
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [lesson()] }) + '\n');
        expect(await pushReviewDecisions(f.pool, f.cache, input())).toEqual({ sent: 0, refused: 0 });
        expect(f.inserts).toHaveLength(1);
        expect(f.inserts[0].slice(0, 6)).toEqual(['acme', 'web', 'repo-hash', 'a1b2c3d4e5f6', 'accepted', 'jane']);
    });

    it('holds everything back for an unlisted repository, one without origin, a member, or a database without the tables', async () => {
        expect((await pushReviewDecisions(fakes().pool, fakes().cache, input({ origin: 'https://github.com/other/api' }))).held).toMatch(/not one of the team's repositories/);
        expect((await pushReviewDecisions(fakes().pool, fakes().cache, input({ origin: undefined }))).held).toMatch(/no origin/);
        const member = fakes('member');
        expect((await pushReviewDecisions(member.pool, member.cache, input())).held).toMatch(/sme or owner/);
        expect(member.inserts).toHaveLength(0);
        const old = fakes('sme', null);
        expect((await pushReviewDecisions(old.pool, old.cache, input())).held).toMatch(/init-schema/);
        expect((await pushReviewDecisions(fakes().pool, fakes().cache, input({ person: 'unknown' }))).held).toMatch(/user.email/);
    });

    it('sets a refused row aside with its reason and does not stop', async () => {
        const f = fakes('sme', '1', '42501');
        expect(await pushReviewDecisions(f.pool, f.cache, input())).toEqual({ sent: 0, refused: 1 });
        expect([...f.sent.values()][0]).toMatch(/^refused by the team database/);
    });

    it('stops on anything else, so the decision is tried again next sync', async () => {
        const f = fakes('sme', '1', 'ECONNRESET');
        await expect(pushReviewDecisions(f.pool, f.cache, input())).rejects.toThrow('refused');
        expect(f.sent.size).toBe(0);
    });
});
