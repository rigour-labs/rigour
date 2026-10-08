import { describe, expect, it } from 'vitest';
import type { ReviewerResult } from '../reviewer.js';
import { reviewerUsage } from './usage.js';

const item = { id: 'abcdef0123', kind: 'finding' as const, class: 'correctness', file: 'src/secret-path.ts', line: 2, issue: 'private text' };

describe('reviewer usage telemetry', () => {
    it('reports counts and buckets only: never file names, finding text or ids', () => {
        const result: ReviewerResult = { outcome: 'findings', items: [item], unverified: [], resolved: [], answerInReply: [], notes: [], advisory: [], disputed: [item, item], dropped: [], dismissed: [], reviewers: ['claude', 'codex', 'cursor'], scope: 'delta', cached: false, costUsd: 0.7, runs: 5,
            mode: { asked: 'panel', ran: 'panel', source: 'team', escalation: '2 risky changed function(s)' } };
        const usage = reviewerUsage(result, 'push');
        expect(usage).toEqual({ outcome: 'findings', trigger: 'push', scope: 'delta', asked: 'panel', ran: 'panel', source: 'team', degraded: false, escalation: 'all-judges', refused: 0, judges: 3, cached: false, confirmed: 1, disputed: 2, dropped: 0, notes: 0, dismissed: 0, runs: 5, cost_bucket: '$0.50-2' });
        const text = JSON.stringify(usage);
        for (const leak of ['secret-path', 'private text', 'abcdef0123']) expect(text).not.toContain(leak);
    });
});
