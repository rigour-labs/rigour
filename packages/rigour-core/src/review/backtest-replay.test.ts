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
    const replay = async (sha: string, options: { configNow?: boolean; configFile?: string; today?: Config; reviewedAt?: string } = {}) => {
        const ledger: Ledger = { rounds: [{ id: 'r1', commit: sha, base: sha, ...(options.reviewedAt !== undefined ? { reviewed_at: options.reviewedAt } : { reviewed_at: REVIEWED_AT }), points: [], must_not_flag: [] }] };
        const seen: { config?: Config; lessons: ReviewLesson[]; path?: string } = { lessons: [] };
        const results = await runBacktest(repo, options.today ?? ConfigSchema.parse({ version: 1 }), ledger, { configNow: options.configNow, configFile: options.configFile, progress: () => undefined, collect: async (tree, _round, config) => {
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

    it('reviews with the commit\'s rigour.yml, today\'s when the commit had none or asked, and a -c file exactly as it is today', async () => {
        const without = commit('no settings yet');
        write('rigour.yml', 'version: 1\ngates:\n  max_file_lines: 123\n');
        const withFile = commit('settings');
        write('rigour.yml', 'version: 1\ngates:\n  max_file_lines: [not, a, number]\n');
        const broken = commit('settings that no longer parse');
        write('rigour.yml', 'version: 1\ngates:\n  max_file_lines: 999\n'); // today's, uncommitted
        const today = ConfigSchema.parse({ version: 1, gates: { max_file_lines: 999 } });
        const lines = async (sha: string, options: Parameters<typeof replay>[1] = {}) => {
            const { result, seen } = await replay(sha, { today, ...options });
            return [seen.config?.gates.max_file_lines, result.replay?.config];
        };
        expect(await lines(withFile)).toEqual([123, "the commit's rigour.yml"]);
        expect(await lines(without)).toEqual([999, "today's rigour.yml (the commit had none)"]);
        expect(await lines(withFile, { configNow: true })).toEqual([999, "today's rigour.yml (--config-now)"]);
        expect((await lines(broken))[0]).toBe(999);
        expect((await lines(broken))[1]).toMatch(/^today's rigour\.yml \(the commit's does not parse: gates\.max_file_lines/);
        // An experiment file nobody committed: used exactly, on every round, whatever the commit has.
        const experiment = ConfigSchema.parse({ version: 1, gates: { max_file_lines: 7 } });
        expect(await lines(withFile, { today: experiment, configFile: 'experiment.yml' })).toEqual([7, "today's experiment.yml (-c)"]);
        fs.rmSync(path.join(repo, 'rigour.yml'));
        expect((await lines(without))[1]).toBe("today's defaults (this checkout has no rigour.yml) (the commit had none)");
    }, 60_000);

    it('serves only lessons learned before the review, as they stood then, and counts those with no timestamp', async () => {
        write('.rigour/review-lessons.json', JSON.stringify({ version: 1, lessons: [
            lesson('before', '2026-04-01T00:00:00Z'),
            lesson('after', '2026-06-01T00:00:00Z'),
            lesson('at-the-review', REVIEWED_AT), // learned as the review was posted: not before it
            // Verified by a person keeping it (its reach) before the review, on one pull request: still verified then.
            lesson('kept', '2026-04-01T00:00:00Z', { state: 'verified', promotedBy: 'person', scope: 'repo', evidence: [
                { kind: 'point', pr: 1, comment: 'c-k', author: 'a reviewer', source: 'person', at: '2026-04-01T00:00:00Z' },
                { kind: 'scoped', pr: 1, comment: 'scoped-1', author: 'a lead', detail: 'repo: every service', at: '2026-04-02T00:00:00Z' },
            ] }),
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
        expect(seen.lessons.map(l => l.id).sort()).toEqual(['before', 'decided', 'kept']);
        expect(seen.lessons.find(l => l.id === 'decided')).toMatchObject({ state: 'candidate', text: 'the first wording' });
        expect(seen.lessons.find(l => l.id === 'kept')).toMatchObject({ state: 'verified', scope: 'repo' });
        expect(result.replay?.lessons).toMatchObject({ served: 3, later: 2, untimed: 1 });
        expect(formatBacktest([result])).toContain(`lessons as of 2026-05-01T12:00:00.000Z (reviewed_at): 3 served, 2 learned later left out, 1 with no timestamp left out`);
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

    it('cuts a round with no reviewed_at off at its commit\'s time, and reads a time with no zone as UTC', async () => {
        const sha = commit('code');
        const { result } = await replay(sha, { reviewedAt: '' });
        expect(result.replay?.asOf).toMatch(/\(the commit's time: the round has no reviewed_at\)$/);
        const zone = process.env.TZ;
        process.env.TZ = 'America/New_York'; // a reviewed_at with no zone is UTC wherever the backtest runs
        try {
            expect((await replay(sha, { reviewedAt: '2026-05-01T12:00:00' })).result.replay?.asOf).toBe('2026-05-01T12:00:00.000Z (reviewed_at)');
        } finally {
            if (zone === undefined) delete process.env.TZ;
            else process.env.TZ = zone;
        }
    }, 60_000);
});

describe('a judge that read the machine\'s own memory', () => {
    it('is named on the round as not isolated, from what its review record says or the home it could not be given', () => {
        const record = { judges: [{ reviewer: 'claude' }, { reviewer: 'cursor', outside_repo: 'cursor also reads your own Cursor rules and settings' }, { reviewer: 'codex', outside_repo: 'codex also reads /repo/.git/rigour-backtest/judge-home/codex-home/config.toml' }] };
        const judges = notIsolated(record, '/repo/.git/rigour-backtest/judge-home', [{ judge: 'codex', why: 'no auth file to carry' }, { judge: 'api', why: 'never ran' }]);
        expect(judges).toEqual(['cursor judge memory not isolated (cursor also reads your own Cursor rules and settings)', 'codex judge memory not isolated (no auth file to carry)']);
        expect(formatReplay({ asOf: REVIEWED_AT, config: "the commit's rigour.yml", dependencies: { used: 'same-lockfile' }, judgesNotIsolated: judges })).toContain('  codex judge memory not isolated (no auth file to carry)');
        expect(notIsolated(undefined, '/x')).toEqual([]);
    });
});
