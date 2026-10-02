import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/** Every open goes to a scratch database, never ~/.rigour/rigour.db. */
const dbFile = vi.hoisted(() => (require('path') as typeof import('path')).join(require('os').tmpdir(), `rigour-telemetry-${process.pid}.db`));
vi.mock('./db.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('./db.js')>();
    return { ...real, openDatabase: (p?: string) => real.openDatabase(p ?? dbFile) };
});

const { openDatabase, isSQLiteAvailable } = await import('./db.js');
const { getCheckpointMetrics, getContextEvents, recordCheckpointMetric, recordContextEvent } = await import('./context-telemetry.js');

const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-a-'));
const repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-b-'));
afterAll(() => {
    for (const p of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(p, { force: true });
    for (const dir of [repoA, repoB]) fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(isSQLiteAvailable())('telemetry scoped to its repository', () => {
    it('migrates idempotently when two processes open the database at once', async () => {
        const [a, b] = await Promise.all([openDatabase(), openDatabase()]);
        const columns = (await a!.all('PRAGMA table_info(checkpoint_metrics)')).map((c: { name: string }) => c.name);
        expect(columns).toContain('repository_id');
        await a!.close();
        await b!.close();
    });

    it("shows a repository its own checkpoints and context events, never another's", async () => {
        await recordCheckpointMetric({ checkpointId: 'cp-a', taskId: 't', agentId: 'agent', checkpointTokens: 10, rawStateTokens: 0, replayTokensAvoided: 0 }, repoA);
        await recordCheckpointMetric({ checkpointId: 'cp-b', taskId: 't', agentId: 'agent', checkpointTokens: 10, rawStateTokens: 0, replayTokensAvoided: 0 }, repoB);
        await recordContextEvent({ toolName: 'rigour_recall', cacheStatus: 'miss', candidateTokens: 0, returnedTokens: 0 }, repoA);

        expect((await getCheckpointMetrics(undefined, repoA)).map(m => m.checkpointId)).toEqual(['cp-a']);
        expect((await getCheckpointMetrics(undefined, repoB)).map(m => m.checkpointId)).toEqual(['cp-b']);
        expect(await getContextEvents(undefined, repoB)).toEqual([]);
        expect((await getContextEvents(undefined, repoA)).map(e => e.toolName)).toEqual(['rigour_recall']);
    });
});
