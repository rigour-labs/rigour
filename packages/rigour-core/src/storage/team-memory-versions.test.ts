import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

Object.assign(process.env, { RIGOUR_ORGANIZATION_ID: 'acme', RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: 'reviewer-s', RIGOUR_TEAM_DATABASE_URL: 'postgresql://localhost/rigour' });
const { listKnowledgeLessons, shareMemoryLesson, transitionLesson } = await import('./lessons.js');
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-versions-'));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

/** Saves a team memory and shares it; returns the shared copy's id. */
async function share(key: string, value: string): Promise<string> {
    const candidate = (await shareMemoryLesson(repo, key, value))!;
    await transitionLesson(candidate, 'promoted', { visibility: 'team', queueSync: true });
    return (await listKnowledgeLessons(repo)).find(l => l.source === `published:${candidate}`)!.id;
}

describe('sharing a team memory replaces the shared version of exactly its key', () => {
    it("leaves a key that only starts like it, and supersedes the key's own shared version", async () => {
        const primary = await share('db: primary', 'postgres-1');
        const first = await share('db', 'sqlite');
        const states = async () => Object.fromEntries((await listKnowledgeLessons(repo)).filter(l => l.source.startsWith('published:')).map(l => [l.id, [l.state, l.supersedesId ?? null]]));
        expect(await states()).toEqual({ [primary]: ['promoted', null], [first]: ['promoted', null] });
        const second = await share('db', 'postgres');
        expect(await states()).toEqual({ [primary]: ['promoted', null], [first]: ['superseded', null], [second]: ['promoted', first] });
    });
});
