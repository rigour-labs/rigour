import { describe, expect, it } from 'vitest';
import { RECALL_LIMIT, rankMemories, type MemoryEntry } from './recall.js';

const memories: MemoryEntry[] = [
    { scope: 'repo', key: 'retry_policy', value: 'Wrap network calls in withRetry from lib/net; never hand-roll backoff.' },
    { scope: 'repo', key: 'db_access', value: 'Reports read from the replica, never the primary.' },
    { scope: 'user', key: 'pr_size', value: 'Keep pull requests under 400 lines.' },
];

/** A stand-in embedding: one dimension per topic word, so similarity is predictable. */
const TOPICS = ['retry', 'backoff', 'network', 'replica', 'report', 'pull', 'request'];
const embed = async (text: string) => TOPICS.map(topic => (text.toLowerCase().includes(topic) ? 1 : 0));

describe('rankMemories', () => {
    it('returns the memories that match by meaning, best first, above the floor', async () => {
        const ranked = await rankMemories('add exponential backoff to a flaky network call', memories, embed);
        expect(ranked.map(m => [m.key, m.match])).toEqual([['retry_policy', 'semantic']]);
    });

    it('returns nothing rather than the closest weak match', async () => {
        expect(await rankMemories('rename a css class', memories, embed)).toEqual([]);
    });

    it('falls back to keyword overlap when the model is unavailable, and says so', async () => {
        const ranked = await rankMemories('replica reports', memories, async () => []);
        expect(ranked.map(m => [m.key, m.match])).toEqual([['db_access', 'keyword']]);
    });

    it(`returns at most ${RECALL_LIMIT}`, async () => {
        const many = Array.from({ length: 10 }, (_, i) => ({ scope: 'repo' as const, key: `retry_${i}`, value: 'network retry backoff' }));
        expect(await rankMemories('network retry backoff', many, embed)).toHaveLength(RECALL_LIMIT);
    });
});
