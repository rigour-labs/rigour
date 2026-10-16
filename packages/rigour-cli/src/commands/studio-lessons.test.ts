import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideLessonFromStudio } from './studio-lessons.js';

const saved = { ...process.env };
let cwd: string;
const TEAM = { RIGOUR_ORGANIZATION_ID: 'acme', RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: 'dev-b', RIGOUR_TEAM_DATABASE_URL: 'postgresql://localhost/rigour' };

/** What the last team sync recorded for this person (core team-access.ts), in this test process's throwaway home. */
async function recordRole(role: string): Promise<void> {
    const { openDatabase } = await import('@rigour-labs/core');
    const db = (await openDatabase())!;
    await db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', 'team_access:acme/web/dev-b', JSON.stringify({ role, candidateReview: true }));
    await db.close();
}

beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lessons-'));
    Object.assign(process.env, TEAM);
});
afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("a decision on a team lesson from Studio's Memory page", () => {
    it('refuses Share and Take back while the role is unknown, and for a member, before anything changes here', async () => {
        for (const body of [{ id: 'lesson-x', state: 'promoted' }, { id: 'lesson-x', takeBack: true }]) {
            expect(await decideLessonFromStudio(cwd, body)).toEqual({ status: 403, body: { error: 'Your team role is not known yet: it is read at the first team sync (rigour team sync).' } });
        }
        await recordRole('member');
        expect(await decideLessonFromStudio(cwd, { id: 'lesson-x', state: 'promoted' })).toEqual({ status: 403, body: { error: 'Only an sme or owner shares a team lesson or takes one back.' } });
    });

    it('lets a member drop, and an sme share or take back (no such lesson here: 404, past the role check)', async () => {
        await recordRole('member');
        expect((await decideLessonFromStudio(cwd, { id: 'lesson-x', state: 'rejected' })).status).toBe(404);
        await recordRole('sme');
        expect((await decideLessonFromStudio(cwd, { id: 'lesson-x', takeBack: true })).status).toBe(404);
    });
});
