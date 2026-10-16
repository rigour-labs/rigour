import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

Object.assign(process.env, { RIGOUR_ORGANIZATION_ID: 'acme', RIGOUR_TEAM_ID: 'web', RIGOUR_ACTOR_ID: 'reviewer-s', RIGOUR_TEAM_DATABASE_URL: 'postgresql://localhost/rigour' });
const { listKnowledgeLessons, shareMemoryLesson, transitionLesson } = await import('./lessons.js');
const { takeBackTeamMemory } = await import('./team-memory-versions.js');
const { sameRepositoryIds, getRepositoryId } = await import('./repository-origin.js');
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

describe('taking back a shared memory', () => {
    const forms = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-forms-'));
    afterAll(() => fs.rmSync(forms, { recursive: true, force: true }));
    const checkout = (name: string, origin: string) => {
        const dir = path.join(forms, name);
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
        return dir;
    };

    it("marks it replaced when a newer version was shared from the same repository's other remote form", async () => {
        const sshConfig = path.join(forms, 'ssh_config');
        fs.writeFileSync(sshConfig, 'Host work-forge\n    HostName forge.example.com\n');
        process.env.RIGOUR_SSH_CONFIG = sshConfig;
        const clone = checkout('clone', 'https://forge.example.com/acme/shop.git');
        const laptop = checkout('laptop', 'git@work-forge:acme/shop.git');
        const sharedIn = async (dir: string, value: string, ids: string[]) => {
            const candidate = (await shareMemoryLesson(dir, 'retries', value))!;
            await transitionLesson(candidate, 'promoted', { visibility: 'team', queueSync: true, repositoryIds: ids });
            return (await listKnowledgeLessons(dir)).find(l => l.source === `published:${candidate}`)!.id;
        };
        // Two shared versions, one under each id, as an earlier version left them (neither replaced the other).
        const older = await sharedIn(laptop, 'retry twice', [await getRepositoryId(laptop)]);
        const newer = await sharedIn(clone, 'retry three times', [await getRepositoryId(clone)]);
        expect(newer).toBeTruthy();
        expect(await takeBackTeamMemory(older, { repositoryIds: sameRepositoryIds(laptop) })).toBe('superseded');
    });
});
