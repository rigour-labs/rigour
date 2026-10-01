import { describe, expect, it } from 'vitest';
import { findingKey, postReview, rankFindings, type ReportFinding, type ReviewReport } from './review-post.js';

const target = { token: 't', repo: 'acme/app', pr: 7, sha: 'abc123' };

function finding(over: Partial<ReportFinding>): ReportFinding {
    return { id: 'x', gate: 'Gate', severity: 'medium', provenance: 'traditional', message: 'm', file: 'src/a.ts', line: 10, ...over };
}

/** A GitHub that remembers comments, and refuses inline reviews when told to. */
function fakeGitHub(state: { review: any[]; issue: any[] }, refuseInline = false) {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const fetchImpl = async (url: string, init: any = {}) => {
        const path = url.replace('https://api.github.com/repos/acme/app', '').replace(/\?.*$/, '');
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });
        const reply = (ok: boolean, json: unknown = {}) => ({ ok, status: ok ? 200 : 422, json: async () => json, text: async () => '' });
        if (method === 'GET' && path === '/pulls/7/comments') return reply(true, state.review);
        if (method === 'GET' && path === '/issues/7/comments') return reply(true, state.issue);
        if (method === 'POST' && path === '/pulls/7/reviews') {
            if (refuseInline) return reply(false);
            state.review.push(...body.comments.map((c: any) => ({ body: c.body })));
            return reply(true);
        }
        if (method === 'POST' && path === '/issues/7/comments') { state.issue.push({ id: 1, body: body.body }); return reply(true); }
        if (method === 'PATCH' && path === '/issues/comments/1') { state.issue[0].body = body.body; return reply(true); }
        return reply(false);
    };
    return { fetchImpl, calls };
}

const report: ReviewReport = {
    status: 'FAIL',
    failures: [
        finding({ gate: 'Style', severity: 'low', message: 'naming' }),
        finding({ gate: 'Race', severity: 'high', provenance: 'deep-analysis', message: 'check-then-act', line: 30, anchor_line: 32 }),
        finding({ gate: 'Leak', severity: 'high', provenance: 'security', message: 'token in log' }),
        finding({ gate: 'NoLine', line: null }),
    ],
    deep: { model: 'anthropic/claude-sonnet-5.5', cost_usd: 0.0421, router: { routed: 3, functions: 11, already_reviewed: 2 } },
};

describe('rankFindings', () => {
    it('puts severity first, then the most provable source', () => {
        expect(rankFindings(report.failures).map(f => f.gate)).toEqual(['Leak', 'Race', 'NoLine', 'Style']);
    });
});

describe('postReview', () => {
    it('posts at most two inline comments on their anchor lines, and one summary', async () => {
        const state = { review: [] as any[], issue: [] as any[] };
        const { fetchImpl, calls } = fakeGitHub(state);
        const result = await postReview(report, target, 2, fetchImpl);
        const review = calls.find(c => c.path === '/pulls/7/reviews')!.body;
        expect(review.commit_id).toBe('abc123');
        expect(review.comments.map((c: any) => [c.path, c.line])).toEqual([['src/a.ts', 10], ['src/a.ts', 32]]);
        expect(review.comments[1].body).toContain('root cause at line 30');
        expect(result).toMatchObject({ inline: 2, summaryUpdated: true });
        expect(state.issue[0].body).toContain('2 already reviewed before the PR');
        expect(state.issue[0].body).toContain('cost $0.042');
    });

    it('never re-posts a finding on the next push, and edits the summary instead of adding one', async () => {
        const state = { review: [] as any[], issue: [] as any[] };
        await postReview(report, target, 2, fakeGitHub(state).fetchImpl);
        const { fetchImpl, calls } = fakeGitHub(state);
        const second = await postReview(report, target, 2, fetchImpl);
        const reposted = calls.find(c => c.path === '/pulls/7/reviews')!.body.comments;
        // Leak and Race went out on the first push; only Style is new.
        expect(reposted).toHaveLength(1);
        expect(reposted[0].body).toContain(findingKey(report.failures[0]));
        expect(second.skippedAlreadyPosted).toBe(2);
        expect(calls.some(c => c.method === 'PATCH')).toBe(true);
        expect(state.issue).toHaveLength(1);
    });

    it('still posts the summary when GitHub refuses an inline comment', async () => {
        const state = { review: [] as any[], issue: [] as any[] };
        const result = await postReview(report, target, 2, fakeGitHub(state, true).fetchImpl);
        expect(result).toMatchObject({ inline: 0, summaryUpdated: true });
        expect(state.issue[0].body).toContain('0 posted inline now');
    });
});
