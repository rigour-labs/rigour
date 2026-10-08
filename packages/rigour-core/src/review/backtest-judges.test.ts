import { describe, expect, it } from 'vitest';
import { formatJudges, judgedFrom, type JudgeCatches } from './backtest-judges.js';
import type { ReviewerResult } from './reviewer.js';

const base: ReviewerResult = { outcome: 'findings', items: [], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [], dropped: [], dismissed: [], reviewers: ['claude', 'codex'], cached: false };

describe('measuring each judge', () => {
    it('computes Cohen\'s kappa between two judges: 1 in full agreement, 0 at chance, and says when they share blind spots', () => {
        const round = (claude: string[], codex: string[]) => ({ judges: { judges: ['claude', 'codex'], caught: { claude, codex }, points: ['p1', 'p2', 'p3', 'p4'], runs: 2 }, points: [] });
        expect(formatJudges([round(['p1', 'p3'], ['p1', 'p3'])])).toContain('kappa 1.00 over 4 point(s) (they share blind spots: a second judge adds little)');
        expect(formatJudges([round(['p1', 'p2'], ['p1', 'p3'])])).toContain('kappa 0.00 over 4 point(s)');
        expect(formatJudges([round(['p1'], ['p2'])])).toMatch(/kappa -0\.\d\d over 4/);
    });

    it('takes each judge\'s own item from the panel, including what it raised in its own words', () => {
        const lock = { id: 'a', kind: 'finding' as const, class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock' };
        const judged = judgedFrom({ ...base, costUsd: 2, runs: 3, panel: [
            { item: lock, judges: ['claude', 'codex'], calls: { claude: 'raised', codex: 'raised' }, status: 'confirmed', members: [{ judge: 'claude', item: lock }, { judge: 'codex', item: { ...lock, id: 'b', line: 3, issue: 'lock taken late' } }] },
        ] });
        expect(judged).toEqual({ judges: ['claude', 'codex'], costUsd: 2, runs: 3, raised: [
            { judge: 'claude', file: 'src/job.ts', line: 2, text: 'returns before the lock' },
            { judge: 'codex', file: 'src/job.ts', line: 3, text: 'lock taken late' },
        ] });
        expect(judgedFrom({ ...base, reviewers: ['claude'] })).toBeUndefined();
    });

    it('reports each judge, what only it found, each pair\'s agreement and the cost of a caught point', () => {
        const round = (caught: JudgeCatches['caught']) => ({ judges: { judges: ['claude', 'codex'], caught, points: ['p1', 'p2', 'p3', 'p4'], runs: 3, costUsd: 3 }, points: ['p1', 'p2', 'p3', 'p4'].map(id => ({ id, caught: Object.values(caught).some(ids => ids.includes(id)) })) });
        const report = formatJudges([round({ claude: ['p1', 'p2'], codex: ['p1', 'p3'] }), round({ claude: ['p1'], codex: ['p1'] })]);
        expect(report).toContain('Judges (2 round(s), 8 human point(s))');
        expect(report).toContain('claude: raised 3/8; 1 that no other judge raised');
        expect(report).toContain('codex: raised 3/8; 1 that no other judge raised');
        expect(report).toMatch(/claude and codex: kappa 0\.\d\d over 8 point\(s\)/);
        expect(report).toContain('6 agent run(s), $6.00 recorded, $1.50 per caught point');
        expect(formatJudges([{ points: [] }])).toBe('');
    });
});
