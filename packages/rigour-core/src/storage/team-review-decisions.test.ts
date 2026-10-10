import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewLesson } from '../review-learning/lessons.js';
import { readLessons } from '../review-learning/lessons.js';
import { readTeamDecisionCache } from '../review-learning/team-decisions.js';
import { repositoryIdSync } from './repository-origin.js';
import { decisionRows, previewReviewDecisions, syncReviewDecisions, type DecisionCache, type DecisionPool } from './team-review-decisions.js';

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

describe('the review decisions sync', () => {
    let repo: string;
    let home: string;
    const saved = process.env.RIGOUR_HOME;
    const scope = { organizationId: 'acme', teamId: 'web', actorId: 'jane', repositories: ['github.com/acme/*'] };
    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-'));
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-home-'));
        process.env.RIGOUR_HOME = home;
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/api']);
        fs.mkdirSync(path.join(repo, 'src', 'orders'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'src', 'orders', 'write.ts'), '');
        execFileSync('git', ['-C', repo, 'add', '-A']);
        fs.mkdirSync(path.join(repo, '.rigour'));
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [lesson()] }));
    });
    afterEach(() => {
        if (saved === undefined) delete process.env.RIGOUR_HOME; else process.env.RIGOUR_HOME = saved;
        fs.rmSync(repo, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    });

    /** A team database and a local cache in memory. `remote` holds the team's rows; an insert adds one, stamped by the "server". */
    function fakes(role = 'sme', version: string | null = '1', refuse?: string) {
        const remote: any[] = [];
        let clock = Date.parse('2026-02-01T00:00:00Z');
        const pool: DecisionPool = {
            query: async (sql, params = []) => {
                if (sql.includes("key = 'review_decisions_version'")) return { rows: version ? [{ value: version }] : [], rowCount: 1 };
                if (sql.includes('FROM rigour.memberships')) return { rows: [{ role, salt: 'org-salt' }], rowCount: 1 };
                if (sql.includes('FROM rigour.review_decisions')) {
                    const rows = remote.filter(r => Date.parse(r.received_at) > Date.parse(String(params[3])));
                    return { rows, rowCount: rows.length };
                }
                if (refuse) throw Object.assign(new Error('refused'), { code: refuse });
                remote.push({ id: `row-${remote.length + 1}`, lesson_id: params[3], kind: params[4], actor_name: 'Jane D.', client_key: params[6], decided_at: params[7], received_at: new Date(clock += 1000).toISOString(), detail: params[8], payload: JSON.parse(String(params[9])) });
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
        /** A teammate's row, as the team database holds it. */
        const teammate = (extra: Record<string, unknown>) => remote.push({
            id: `t-${remote.length + 1}`, lesson_id: 'a1b2c3d4e5f6', actor_name: 'Omar K.', client_key: `other-${remote.length}`,
            decided_at: '2026-02-02T00:00:00Z', received_at: new Date(clock += 1000).toISOString(), detail: '', payload: { points: [] }, ...extra,
        });
        return { pool, cache, remote, sent, teammate };
    }
    const input = (extra = {}) => ({ cwd: repo, origin: 'https://github.com/acme/api', repositoryId: repositoryIdSync(repo), person: ME, scope, ...extra });

    it('sends each decision once: an unchanged store is not read again, and a sent key is never resent', async () => {
        const f = fakes();
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ sent: 1, refused: 0, received: 0 });
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ sent: 0 });
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [lesson()] }) + '\n');
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ sent: 0 });
        expect(f.remote.map(r => [r.lesson_id, r.kind])).toEqual([['a1b2c3d4e5f6', 'accepted']]);
    });

    it('neither sends nor receives for an unlisted repository or one without origin, and writes no cache for it', async () => {
        const f = fakes();
        f.teammate({ kind: 'rejected' });
        expect((await syncReviewDecisions(f.pool, f.cache, input({ origin: 'https://github.com/other/api' }))).held).toMatch(/not one of the team's repositories/);
        expect((await syncReviewDecisions(f.pool, f.cache, input({ origin: undefined }))).held).toMatch(/no origin/);
        expect(fs.existsSync(path.join(home, '.rigour', 'team-decisions'))).toBe(false);
    });

    it('a member receives but does not send, and the cache says why it does not share', async () => {
        const f = fakes('member');
        f.teammate({ kind: 'rejected', detail: 'one-off' });
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ sent: 0, received: 1, held: expect.stringMatching(/sme or owner/) });
        expect(readTeamDecisionCache(repo)?.sharing).toEqual({ shares: false, reason: "a member's decisions stay on this machine: an sme or owner shares them" });
        const old = fakes('sme', null);
        expect((await syncReviewDecisions(old.pool, old.cache, input())).held).toMatch(/init-schema/);
    });

    it('a teammate\'s later rejection wins over my earlier, already received acceptance; the store is never written', async () => {
        const f = fakes();
        await syncReviewDecisions(f.pool, f.cache, input());
        f.teammate({ kind: 'rejected', detail: 'not for this repo' });
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ received: 1 });
        const scan = readLessons(repo).find(l => l.id === 'a1b2c3d4e5f6')!;
        expect(scan.state).toBe('rejected');
        expect(scan.evidence.at(-1)).toMatchObject({ kind: 'rejected', author: '', team: { name: 'Omar K.' } });
        expect(JSON.stringify(JSON.parse(fs.readFileSync(path.join(repo, '.rigour', 'review-lessons.json'), 'utf8')))).not.toContain('Omar');
    });

    it('my decision not yet back holds over a teammate\'s; once back, the order is when the team database got each', async () => {
        const f = fakes();
        f.teammate({ kind: 'rejected' }); // the team rejected it before my acceptance reached the database
        expect(await syncReviewDecisions(f.pool, f.cache, input())).toMatchObject({ sent: 1, received: 1 });
        expect(readLessons(repo).find(l => l.id === 'a1b2c3d4e5f6')!.state).toBe('verified');
        expect(Object.keys(readTeamDecisionCache(repo)!.mine)).toHaveLength(1); // mine came back with its received time
    });

    it('a member\'s own decision is ordered by when it was made, so a later team decision wins on that machine', async () => {
        const f = fakes('member');
        f.teammate({ kind: 'rejected', received_at: '2026-03-01T00:00:00Z' }); // after my acceptance of 2026-01-02
        await syncReviewDecisions(f.pool, f.cache, input());
        expect(readLessons(repo).find(l => l.id === 'a1b2c3d4e5f6')!.state).toBe('rejected');
    });

    it('a teammate\'s lesson this clone never learned is served from its approved wording, its file found from the hash', async () => {
        const f = fakes();
        const file = decisionRows([lesson({ id: 'ffffffffffff' })], { ...context, repositoryId: repositoryIdSync(repo) })[0].payload.file;
        f.teammate({ lesson_id: 'ffffffffffff', kind: 'accepted', payload: { text: 'Close every cursor in a finally block.', file, points: [{ pr: 3, comment: '77', source: 'person' }] } });
        await syncReviewDecisions(f.pool, f.cache, input());
        const adopted = readLessons(repo).find(l => l.id === 'ffffffffffff')!;
        expect(adopted).toMatchObject({ text: 'Close every cursor in a finally block.', file: 'src/orders/write.ts', state: 'verified' });
    });

    it('a dry run says what the first sync sends, and which decisions in the store stay because someone else made them', async () => {
        const evidence = [
            ...lesson().evidence,
            { kind: 'rejected' as const, pr: 7, comment: 'rejected-x', author: 'teammate@example.com', at: '2026-01-03T00:00:00Z' },
            { kind: 'dismissed' as const, pr: 7, comment: 'dismissed-x', author: 'unknown', at: '2026-01-04T00:00:00Z' },
        ];
        fs.writeFileSync(path.join(repo, '.rigour', 'review-lessons.json'), JSON.stringify({ version: 1, lessons: [lesson({ evidence })] }));
        const f = fakes();
        expect(await previewReviewDecisions(f.cache, input())).toEqual({ yours: 1, notYours: { 'teammate@example.com': 1, 'no git email': 1 } });
        expect(f.remote).toHaveLength(0); // a dry run sends nothing
        await syncReviewDecisions(f.pool, f.cache, input());
        expect((await previewReviewDecisions(f.cache, input())).yours).toBe(0);
        expect((await previewReviewDecisions(f.cache, input({ origin: 'https://github.com/other/api' }))).held).toMatch(/not one of the team's repositories/);
    });

    it('sets a refused row aside with its reason and does not stop; anything else stops and keeps the decision', async () => {
        const refused = fakes('sme', '1', '42501');
        expect(await syncReviewDecisions(refused.pool, refused.cache, input())).toMatchObject({ sent: 0, refused: 1 });
        expect([...refused.sent.values()][0]).toMatch(/^refused by the team database/);
        const down = fakes('sme', '1', 'ECONNRESET');
        await expect(syncReviewDecisions(down.pool, down.cache, input())).rejects.toThrow('refused');
        expect(down.sent.size).toBe(0);
    });
});
