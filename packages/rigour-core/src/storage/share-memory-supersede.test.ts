/**
 * A corrected team memory replaces its pending candidate, against the real local store: re-remembering a key whose
 * candidate is still waiting on a person supersedes the old one (linked from the new one, and queued for sync so the
 * team database sees it superseded too), rather than leaving two candidates side by side.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('./team-store.js', () => ({ loadTeamConfiguration: async () => ({ organizationId: 'example-org', teamId: 'web', actorId: 'sam' }) }));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-home-'));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'supersede-repo-'));
const saved = process.env.RIGOUR_HOME;

describe('re-remembering a team memory', () => {
    beforeAll(() => {
        process.env.RIGOUR_HOME = home;
        fs.mkdirSync(path.join(repo, '.git'));
        fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://forge.example.com/example-org/widgets.git\n');
    });
    afterAll(() => {
        if (saved === undefined) delete process.env.RIGOUR_HOME;
        else process.env.RIGOUR_HOME = saved;
        for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('supersedes the pending candidate for that key, and leaves other keys alone', async () => {
        // Imported here: the local store's path comes from RIGOUR_HOME when the module loads.
        const { shareMemoryLesson } = await import('./lessons.js');
        const { openDatabase } = await import('./db.js');
        const first = await shareMemoryLesson(repo, 'retries', 'Use withRetry.');
        const other = await shareMemoryLesson(repo, 'naming', 'Hooks are named useX.');
        const corrected = await shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net, three attempts.');
        expect(new Set([first, other, corrected]).size).toBe(3);

        const db = (await openDatabase())!;
        try {
            const rows = await db.all('SELECT id, state, subject, supersedes_id FROM lessons WHERE kind = ? ORDER BY created_at', 'memory');
            const byId = Object.fromEntries(rows.map((r: any) => [r.id, r]));
            expect(byId[first!]).toMatchObject({ state: 'superseded' });
            expect(byId[corrected!]).toMatchObject({ state: 'candidate', supersedes_id: first, subject: 'retries: Use withRetry from lib/net, three attempts.' });
            expect(byId[other!]).toMatchObject({ state: 'candidate', supersedes_id: null });
            expect(rows.filter((r: any) => r.state === 'candidate').map((r: any) => r.id).sort()).toEqual([corrected, other].sort());
            // The old candidate's new state goes to the team database with the next sync, as the new one does.
            const queued = await db.all("SELECT entity_id FROM sync_outbox WHERE synced_at IS NULL");
            expect(queued.filter((q: any) => q.entity_id === first).length).toBeGreaterThan(1);
            expect(queued.some((q: any) => q.entity_id === corrected)).toBe(true);
        } finally {
            await db.close();
        }

        // The same value again changes nothing.
        expect(await shareMemoryLesson(repo, 'retries', 'Use withRetry from lib/net, three attempts.')).toBe(corrected);
    });

    it('never supersedes a memory a person already promoted (promotion publishes a copy)', async () => {
        const { shareMemoryLesson, transitionLesson } = await import('./lessons.js');
        const { openDatabase } = await import('./db.js');
        const original = await shareMemoryLesson(repo, 'logging', 'Log the request id.');
        expect(await transitionLesson(original!, 'promoted', { visibility: 'team' })).toBe(true);
        const next = await shareMemoryLesson(repo, 'logging', 'Log the request id and the tenant.');
        const db = (await openDatabase())!;
        try {
            const published = await db.get("SELECT state FROM lessons WHERE source = ?", `published:${original}`);
            expect(published).toMatchObject({ state: 'promoted' });
            expect(await db.get('SELECT state FROM lessons WHERE id = ?', original)).toMatchObject({ state: 'candidate' });
            expect(await db.get('SELECT state, supersedes_id FROM lessons WHERE id = ?', next)).toMatchObject({ state: 'candidate', supersedes_id: null });
        } finally {
            await db.close();
        }
    });

    it('brings an earlier value back as a new candidate that supersedes the current one', async () => {
        const { shareMemoryLesson } = await import('./lessons.js');
        const { openDatabase } = await import('./db.js');
        const a = await shareMemoryLesson(repo, 'timeouts', 'Thirty seconds.');
        const b = await shareMemoryLesson(repo, 'timeouts', 'Sixty seconds.');
        const back = await shareMemoryLesson(repo, 'timeouts', 'Thirty seconds.');
        expect(back).not.toBe(a);
        const db = (await openDatabase())!;
        try {
            expect(await db.get('SELECT state FROM lessons WHERE id = ?', b)).toMatchObject({ state: 'superseded' });
            expect(await db.get('SELECT state, supersedes_id FROM lessons WHERE id = ?', back)).toMatchObject({ state: 'candidate', supersedes_id: b });
        } finally {
            await db.close();
        }
    });

    it("never touches another person's candidate for the same key", async () => {
        const { shareMemoryLesson } = await import('./lessons.js');
        const { getRepositoryId } = await import('./repository-origin.js');
        const { encryptLocalPayload } = await import('./local-encryption.js');
        const { openDatabase } = await import('./db.js');
        const theirs = 'lesson-someone-else';
        const db = (await openDatabase())!;
        try {
            await db.run(
                `INSERT INTO lessons (id, repository_id, actor_id, team_id, visibility, state, kind, subject, evidence_json, confidence, source, created_at, updated_at)
                 VALUES (?, ?, 'teammate', 'web', 'team', 'candidate', 'memory', ?, ?, 0.5, 'rigour_remember', 1, 1)`,
                theirs, await getRepositoryId(repo), 'paging: Use cursors.', await encryptLocalPayload({ key: 'paging', value: 'Use cursors.' }),
            );
        } finally {
            await db.close();
        }
        const mine = await shareMemoryLesson(repo, 'paging', 'Use keyset pagination.');
        const check = (await openDatabase())!;
        try {
            expect(await check.get('SELECT state FROM lessons WHERE id = ?', theirs)).toMatchObject({ state: 'candidate' });
            expect(await check.get('SELECT supersedes_id FROM lessons WHERE id = ?', mine)).toMatchObject({ supersedes_id: null });
        } finally {
            await check.close();
        }
    });
});
