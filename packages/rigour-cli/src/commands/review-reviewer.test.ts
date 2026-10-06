import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewerResult } from '@rigour-labs/core';
import { printReviewer, reviewerJson } from './review-reviewer.js';

let out: string[];
beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
});
afterEach(() => {
    vi.restoreAllMocks();
});

const LOCK = { id: 'abcdef0123', kind: 'finding' as const, class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', consequence: 'two runs send the same email', reviewer: 'claude+codex' };
const base: ReviewerResult = { outcome: 'findings', items: [LOCK], unverified: [], resolved: [], answerInReply: [], notes: [{ ...LOCK, id: 'n1', issue: 'could be shorter', consequence: undefined }], disputed: [{ ...LOCK, id: 'd1', issue: 'maybe slow' }], dropped: [{ ...LOCK, id: 'x1' }], dismissed: [], reviewers: ['claude', 'codex'], scope: 'full', cached: false };

describe('the reviewer as the CLI prints it', () => {
    it('shows what ran against what was asked, why, what was refused, and only confirmed findings as open', () => {
        printReviewer({ ...base, mode: { asked: 'panel', ran: 'single', source: 'user', degraded: '3 judges asked, claude could run (not installed: codex)', refused: ['mode single (flag) refused: rigour.yml sets review.reviewer.panel: required'] } });
        const text = out.join('\n');
        expect(text).toContain('panel asked (user), single ran: 3 judges asked, claude could run (not installed: codex)');
        expect(text).toContain('mode single (flag) refused');
        expect(text).toContain('OPEN');
        expect(text).toContain('consequence: two runs send the same email');
        expect(text).toContain('not a bug? rigour dismiss abcdef0123');
        expect(text).toContain('disputed, never blocks (no majority)');
        expect(text).toContain('note, never blocks');
        expect(text).toContain('1 finding(s) refuted with evidence by the other judges');
    });

    it('returns every decision in JSON', () => {
        expect(reviewerJson({ ...base, mode: { asked: 'panel', ran: 'panel', source: 'team' } })).toMatchObject({ blocks: true, mode: { ran: 'panel' }, disputed: [{ id: 'd1' }], notes: [{ id: 'n1' }], dropped: [{ id: 'x1' }] });
    });
});
