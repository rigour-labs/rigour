/**
 * Recall on a machine whose team lessons arrive by sync: a no-argument recall lists the lessons an agent may act on,
 * and a recall that answers before the first team sync has finished says the team's lessons are on their way.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ team: null as null | object, lessons: [] as Array<Record<string, unknown>>, sync: (async () => ({})) as () => Promise<unknown> }));
vi.mock('@rigour-labs/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@rigour-labs/core')>()),
    loadTeamConfiguration: async () => core.team,
    listKnowledgeLessons: async () => core.lessons,
    hasPulledTeamLessons: async () => false,
    syncTeamOutbox: () => core.sync(),
}));
const { handleRecall } = await import('./memory-recall.js');

const text = (result: { content: Array<{ text: string }> }) => result.content.map(c => c.text).join('\n');
const promoted = (subject: string) => ({ id: `lesson-${subject.length}`, subject, state: 'promoted', visibility: 'team' });
let repo: string;
let home: string;
const realHome = process.env.RIGOUR_HOME;

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-team-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-team-home-'));
    process.env.RIGOUR_HOME = home;
    core.team = { organizationId: 'example-org', teamId: 'web', actorId: 'sam' };
    core.lessons = [];
    core.sync = async () => ({});
});
afterEach(() => {
    if (realHome === undefined) delete process.env.RIGOUR_HOME;
    else process.env.RIGOUR_HOME = realHome;
    for (const dir of [repo, home]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('recall with the team\'s lessons', () => {
    it('lists promoted team lessons when called with no arguments, even with no local memory', async () => {
        core.lessons = [promoted('migration-order: Additive migrations ship before the code that uses them.')];
        const recalled = text(await handleRecall(repo));
        expect(recalled).toContain('LESSONS (validated by repeated fixes, or promoted by a person');
        expect(recalled).toContain('migration-order: Additive migrations ship before the code that uses them. (promoted)');
        expect(recalled).not.toContain('NO MEMORIES STORED');
    });

    it('says the team\'s lessons are still on their way when the first sync has not finished', async () => {
        core.sync = () => new Promise(() => undefined);
        expect(text(await handleRecall(repo, {}, { teamWaitMs: 50 }))).toContain("NO MEMORIES STORED. Use rigour_remember to persist important instructions.\n\nThe team's lessons are still being fetched");
        expect(text(await handleRecall(repo, { query: 'migrations' }, { teamWaitMs: 50 }))).toContain("The team's lessons are still being fetched");
    });

    it('says why when the team database could not be reached', async () => {
        core.sync = async () => { throw new Error('Cannot reach the team database (ECONNREFUSED)'); };
        expect(text(await handleRecall(repo))).toContain("The team's lessons could not be fetched from the team database (Cannot reach the team database (ECONNREFUSED)); recall again to retry, or run `rigour team doctor`.");
    });

    it('says nothing about the team once the first sync is done', async () => {
        expect(text(await handleRecall(repo, { query: 'migrations' }))).not.toContain('still being fetched');
        expect(text(await handleRecall(repo))).not.toContain('still being fetched');
    });

    it('says nothing about the team without team mode', async () => {
        core.team = null;
        core.sync = () => new Promise(() => undefined);
        expect(text(await handleRecall(repo))).toContain('NO MEMORIES STORED');
        expect(text(await handleRecall(repo))).not.toContain('still being fetched');
    });
});
