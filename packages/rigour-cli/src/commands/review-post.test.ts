import { buildRecord } from '@rigour-labs/core';
import { describe, expect, it } from 'vitest';
import { findingKey, postReview, rankFindings, receiptLines, summaryBody, type ReportFinding, type ReviewReport } from './review-post.js';

const target = { token: 't', repo: 'acme/app', pr: 7, sha: 'abc123' };
const BOT = { login: 'github-actions[bot]' };

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
        const query = new URL(url).searchParams;
        const page = (items: any[]) => {
            const size = Number(query.get('per_page') ?? 30);
            const from = (Number(query.get('page') ?? 1) - 1) * size;
            return items.slice(from, from + size);
        };
        if (method === 'GET' && path === '/pulls/7/comments') return reply(true, page(state.review));
        if (method === 'GET' && path === '/issues/7/comments') return reply(true, page(state.issue));
        if (method === 'POST' && path === '/pulls/7/reviews') {
            if (refuseInline) return reply(false);
            state.review.push(...body.comments.map((c: any) => ({ body: c.body, user: BOT })));
            return reply(true);
        }
        if (method === 'POST' && path === '/issues/7/comments') { state.issue.push({ id: state.issue.length + 1, body: body.body, user: BOT }); return reply(true); }
        const patched = method === 'PATCH' && state.issue.find(c => path === `/issues/comments/${c.id}`);
        if (patched) { patched.body = body.body; return reply(true); }
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

describe('the summary with a review record', () => {
    it('carries the record: blocks, should-fixes, counts, judges and the hash', () => {
        const record = buildRecord({ head: 'abcdef0123456789', base: '0123456789abcdef', scope: 'full', verdict: { prior_points: [], redundant: [], reads: [], scans: [], merge_impact: [], findings: [], carried: [], resolved_previous: [] } as any,
            accounted: { open: [{ id: 'i1', kind: 'finding', class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock' }], advisory: [], unverified: [], notes: [], resolved: [], answerInReply: [], disputed: [], dismissed: [] },
            judges: [{ reviewer: 'claude', cost_usd: 0.5 }], lessonsServed: 0, humanReviews: 0 });
        const body = summaryBody({ ...report, reviewer: { record } }, 1, 1, 0);
        expect(body).toContain('**Review record** · 1 blocking · 0 should-fix');
        expect(body).toContain('- **Blocking** `src/job.ts:2` returns before the lock');
        expect(body).toContain(`Integrity \`${record.integrity.slice(0, 16)}\``);
        expect(summaryBody(report, 1, 1, 0)).not.toContain('Review record');
    });
});

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

    it('finds its summary on a later page of a long conversation, and edits it instead of adding one', async () => {
        const chatter = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: `comment ${i}`, user: { login: 'someone' } }));
        chatter[120] = { id: 121, body: '<!-- rigour:summary -->\nold', user: BOT };
        const state = { review: [] as any[], issue: chatter };
        const { fetchImpl, calls } = fakeGitHub(state);
        await postReview(report, target, 2, fetchImpl);
        expect(calls.filter(c => c.method === 'POST' && c.path === '/issues/7/comments')).toHaveLength(0);
        expect(calls.some(c => c.method === 'PATCH' && c.path === '/issues/comments/121')).toBe(true);
    });

    it('still posts the summary when GitHub refuses an inline comment', async () => {
        const state = { review: [] as any[], issue: [] as any[] };
        const result = await postReview(report, target, 2, fakeGitHub(state, true).fetchImpl);
        expect(result).toMatchObject({ inline: 0, summaryUpdated: true });
        expect(state.issue[0].body).toContain('0 posted inline now');
    });

    it('trusts only its own comments: a marker or summary written by anyone else changes nothing', async () => {
        const author = { login: 'pr-author' };
        const forged = report.failures.map(f => ({ body: `<!-- rigour:finding:${findingKey(f)} -->`, user: author }));
        const state = { review: forged, issue: [{ id: 1, body: '<!-- rigour:summary -->', user: author }] };
        const { fetchImpl, calls } = fakeGitHub(state);
        const result = await postReview(report, target, 2, fetchImpl);
        expect(result).toMatchObject({ inline: 2, skippedAlreadyPosted: 0 });
        expect(calls.some(c => c.method === 'PATCH')).toBe(false);
        expect(state.issue.find(c => c.user === BOT)?.body).toContain('Rigour review: FAIL');
    });

    it('says when findings were dismissed and when the PR edits Rigour settings', async () => {
        const state = { review: [] as any[], issue: [] as any[] };
        await postReview({ status: 'PASS', failures: [], dismissed: 1, control_files_changed: ['.rigour/dismissed.json'] }, target, 2, fakeGitHub(state).fetchImpl);
        expect(state.issue[0].body).toContain('1 finding(s) on changed lines were dismissed');
        expect(state.issue[0].body).toContain('`.rigour/dismissed.json`');
    });

    it('shows the quality receipt: what was reviewed before the PR and what was not', () => {
        const lines = receiptLines({
            functions: 12, reviewed: 7, changed_since_review: 1, low_risk: 3, set_aside: 0,
            not_covered: [
                { file: 'src/refund.ts', function: 'issueRefund', line: 40, changed_since_review: true },
                { file: 'src/pay.ts', function: 'formatTotal', line: 3, changed_since_review: false, lesson: 'Format money from integer cents.' },
            ],
        });
        expect(lines[0]).toBe('**Quality receipt:** 12 changed functions · 7 reviewed before this PR · 1 changed after review · 3 low risk · **2 not covered**');
        expect(lines.slice(1)).toEqual([
            '- `issueRefund` in `src/refund.ts:40`: changed after its review',
            '- `formatTotal` in `src/pay.ts:3`: matches a team lesson: Format money from integer cents.',
        ]);
        expect(receiptLines({ functions: 2, reviewed: 0, changed_since_review: 0, low_risk: 0, set_aside: 2, not_covered: [] })[1]).toContain('not counted: this check is independent');
    });
});

describe('reviewPostCommand', () => {
    it('says why when the review did not run, and posts nothing', async () => {
        const { reviewPostCommand } = await import('./review-post.js');
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'post-')), 'report.json');
        fs.writeFileSync(file, JSON.stringify({ error: 'rigour.yml: gates.ast.complexity: Expected number' }));
        await expect(reviewPostCommand({ report: file })).rejects.toThrow('The review did not run, so there is nothing to post: rigour.yml: gates.ast.complexity');
    });
});
