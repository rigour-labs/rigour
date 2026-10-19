import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema, type Config } from '../types/index.js';
import { formatBacktest, runBacktest, type Ledger } from './backtest.js';
import { formatReplay, notIsolated } from './backtest-replay.js';
import { lessonsPath, readLessons, type ReviewLesson } from '../review-learning/lessons.js';
import { teamDecisionCachePath, type ReceivedDecision } from '../review-learning/team-decisions.js';
import { repositoryIdSync } from '../storage/repository-origin.js';

const REVIEWED_AT = '2026-05-01T12:00:00Z';
const lesson = (id: string, createdAt: string | undefined, over: Partial<ReviewLesson> = {}): ReviewLesson => ({
    id, text: `lesson ${id} about the invoice export`, file: 'src/export.ts', symbols: [], state: 'candidate', createdAt: createdAt as string, updatedAt: createdAt as string,
    evidence: [{ kind: 'point', pr: 1, comment: `c-${id}`, author: 'a reviewer', source: 'person', at: createdAt }], ...over,
});
const decision = (id: string, decidedAt: string): ReceivedDecision => ({ id, lessonId: `team-${id}`, kind: 'accepted', decidedAt, receivedAt: decidedAt, detail: '', text: `team lesson ${id} on the export`, file: 'src/export.ts', points: [{ pr: 2, comment: `t-${id}`, source: 'person' }] });

describe('a backtest round sees only what existed at its time', () => {
    let repo: string;
    let home: string;
    const saved = { home: process.env.RIGOUR_HOME, lessons: process.env.RIGOUR_REVIEW_LESSONS };
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const write = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), body);
    };
    const commit = (message: string) => {
        git('add', '-A');
        git('commit', '-qm', message);
        return git('rev-parse', 'HEAD');
    };
    /** Runs one round on `sha`, returning what the round saw. */
    const replay = async (sha: string, options: { configNow?: boolean; today?: Config; reviewedAt?: string } = {}) => {
        const ledger: Ledger = { rounds: [{ id: 'r1', commit: sha, base: sha, ...(options.reviewedAt !== undefined ? { reviewed_at: options.reviewedAt } : { reviewed_at: REVIEWED_AT }), points: [], must_not_flag: [] }] };
        const seen: { config?: Config; lessons: ReviewLesson[]; path?: string } = { lessons: [] };
        const results = await runBacktest(repo, options.today ?? ConfigSchema.parse({ version: 1 }), ledger, { configNow: options.configNow, progress: () => undefined, collect: async (tree, _round, config) => {
            seen.config = config;
            seen.lessons = readLessons(tree);
            seen.path = lessonsPath(tree);
            return { items: [] };
        } });
        return { result: results[0], seen };
    };

    beforeEach(() => {
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-replay-'));
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-replay-home-'));
        process.env.RIGOUR_HOME = home;
        delete process.env.RIGOUR_REVIEW_LESSONS;
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 't@example.com');
        git('config', 'user.name', 't');
        git('config', 'commit.gpgsign', 'false');
        git('remote', 'add', 'origin', 'https://example.com/example-org/example-shop.git');
        write('src/export.ts', 'export const rows = 1;\n');
    });
    afterEach(() => {
        for (const [name, value] of [['RIGOUR_HOME', saved.home], ['RIGOUR_REVIEW_LESSONS', saved.lessons]] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        try { git('worktree', 'prune'); } catch { /* the repository may be gone */ }
        fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('reviews with the commit\'s rigour.yml, the defaults when it had none, and today\'s only when asked', async () => {
        const without = commit('no settings yet');
        write('rigour.yml', 'version: 1\ngates:\n  max_file_lines: 123\n');
        const withFile = commit('settings');
        const today = ConfigSchema.parse({ version: 1, gates: { max_file_lines: 999 } });
        const atCommit = await replay(withFile, { today });
        expect(atCommit.seen.config?.gates.max_file_lines).toBe(123);
        expect(atCommit.result.replay?.config).toBe("the commit's rigour.yml");
        const defaults = await replay(without, { today });
        expect(defaults.seen.config?.gates.max_file_lines).toBe(ConfigSchema.parse({}).gates.max_file_lines);
        expect(defaults.result.replay?.config).toBe('the defaults (the commit has no rigour.yml)');
        const now = await replay(withFile, { today, configNow: true });
        expect(now.seen.config?.gates.max_file_lines).toBe(999);
        expect(formatBacktest([now.result])).toContain("config: today's rigour.yml (--config-now)");
    }, 60_000);

    it('serves only lessons learned before the review, as they stood then, and counts those with no timestamp', async () => {
        write('.rigour/review-lessons.json', JSON.stringify({ version: 1, lessons: [
            lesson('before', '2026-04-01T00:00:00Z'),
            lesson('after', '2026-06-01T00:00:00Z'),
            lesson('untimed', undefined, { evidence: [{ kind: 'point', pr: 1, comment: 'c-u', author: 'a reviewer', source: 'person' }] }),
            // Accepted and reworded after the review: then, it was a candidate with its first wording.
            lesson('decided', '2026-04-01T00:00:00Z', { state: 'verified', promotedBy: 'person', text: 'the newer wording', evidence: [
                { kind: 'point', pr: 1, comment: 'c-d', author: 'a reviewer', source: 'person', at: '2026-04-01T00:00:00Z' },
                { kind: 'accepted', pr: 1, comment: 'accepted-1', author: 'a lead', at: '2026-05-20T00:00:00Z' },
                { kind: 'reworded', pr: 1, comment: 'reworded-1', author: 'a lead', detail: 'clearer; was: the first wording', at: '2026-05-21T00:00:00Z' },
            ] }),
        ] }));
        const sha = commit('lessons tracked with the code');
        const { result, seen } = await replay(sha);
        expect(seen.lessons.map(l => l.id).sort()).toEqual(['before', 'decided']);
        expect(seen.lessons.find(l => l.id === 'decided')).toMatchObject({ state: 'candidate', text: 'the first wording' });
        expect(result.replay?.lessons).toMatchObject({ served: 2, later: 1, untimed: 1 });
        expect(formatBacktest([result])).toContain(`lessons as of 2026-05-01T12:00:00.000Z (reviewed_at): 2 served, 1 learned later left out, 1 with no timestamp left out`);
        expect(readLessons(path.join(repo, '.git', 'rigour-backtest', 'checkout')).map(l => l.id)).toContain('after'); // outside the round, nothing is cut off
    }, 60_000);

    it('ignores RIGOUR_REVIEW_LESSONS, and says so', async () => {
        const outside = path.join(home, 'shared-lessons.json');
        fs.writeFileSync(outside, JSON.stringify({ version: 1, lessons: [lesson('shared', '2026-04-01T00:00:00Z')] }));
        process.env.RIGOUR_REVIEW_LESSONS = outside;
        const { result, seen } = await replay(commit('code'));
        expect(seen.lessons).toEqual([]);
        expect(seen.path).not.toBe(outside);
        expect(result.replay?.lessonsEnvIgnored).toContain('RIGOUR_REVIEW_LESSONS');
        expect(formatBacktest([result])).toContain('is set and ignored');
    }, 60_000);

    it('takes a team decision only when it was made before the review', async () => {
        const sha = commit('code');
        const cache = teamDecisionCachePath(repositoryIdSync(repo));
        fs.mkdirSync(path.dirname(cache), { recursive: true });
        fs.writeFileSync(cache, JSON.stringify({ version: 1, sharing: { shares: false }, mine: {}, decisions: [decision('early', '2026-04-15T00:00:00Z'), decision('late', '2026-05-15T00:00:00Z'), decision('odd', 'not a time')] }));
        const { result, seen } = await replay(sha);
        expect(seen.lessons.map(l => l.id)).toEqual(['team-early']);
        expect(result.replay?.lessons?.teamLeftOut).toBe(2);
        expect(readLessons(repo).map(l => l.id).sort()).toEqual(['team-early', 'team-late', 'team-odd']); // a live read is unchanged
    }, 60_000);

    it('cuts a round with no reviewed_at off at its commit\'s time', async () => {
        const sha = commit('code');
        const { result } = await replay(sha, { reviewedAt: '' });
        expect(result.replay?.asOf).toMatch(/\(the commit's time: the round has no reviewed_at\)$/);
    }, 60_000);
});

describe('a judge that read the machine\'s own memory', () => {
    it('is named on the round as not isolated, from what its review record says', () => {
        const judges = notIsolated({ judges: [{ reviewer: 'claude' }, { reviewer: 'cursor', outside_repo: 'cursor also reads your own Cursor rules and settings' }] });
        expect(judges).toEqual(['cursor: cursor also reads your own Cursor rules and settings']);
        expect(formatReplay({ asOf: REVIEWED_AT, config: "the commit's rigour.yml", dependencies: { used: 'same-lockfile' }, judgesNotIsolated: judges })).toContain('  judge memory not isolated: cursor: cursor also reads your own Cursor rules and settings');
        expect(notIsolated(undefined)).toEqual([]);
    });
});
