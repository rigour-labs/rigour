import { describe, expect, it } from 'vitest';
import { humanReviews, type PullRequest } from './inputs.js';

const pr: PullRequest = { number: 7, state: 'open', draft: false, author: 'author', body: '' };
const reviews = [
    { id: 1, user: { login: 'senior', type: 'User' }, body: 'Keep a separate case for a visitor with no account.', state: 'CHANGES_REQUESTED', submitted_at: '2026-09-25T18:09:11Z', commit_id: 'a0a0a0a0a0aa' },
    { id: 2, user: { login: 'senior', type: 'User' }, body: '', state: 'APPROVED', submitted_at: '2026-09-28T15:12:53Z', commit_id: 'b1b1b1b1b1bb' },
    { id: 3, user: { login: 'author', type: 'User' }, body: '', state: 'APPROVED', submitted_at: '2026-09-28T16:00:00Z', commit_id: 'b1b1b1b1b1bb' },
];
const gh = async (args: string[]) => ({ exitCode: 0, stdout: JSON.stringify(args[1].endsWith('/reviews') ? reviews : []), stderr: '' });

describe('the human reviews a judge reads', () => {
    it('keeps an approval without words: it settles the points its author raised before it', async () => {
        const { reviews: read } = await humanReviews(gh, pr, undefined);
        expect(read!.markdown).toContain('## Review by senior, 2026-09-25T18:09:11Z, CHANGES_REQUESTED (on a0a0a0a0a)');
        expect(read!.markdown).toContain('## Review by senior, 2026-09-28T15:12:53Z, APPROVED (on b1b1b1b1b)\n\n(approved without comment: every point senior raised before this is settled)');
        expect(read!.approvals).toEqual([{ login: 'senior', at: '2026-09-28T15:12:53Z', commit: 'b1b1b1b1b1bb' }]); // the author's own approval is not a review
        expect(read!.count).toBe(1); // reviews with points: the judge must answer those, and an approval has none
        expect(read!.label).toBe('senior, 2026-09-28T15:12:53Z (1 review)');
    });

    it('hides the approval like any review from the reviewed moment on', async () => {
        const { reviews: read } = await humanReviews(gh, pr, '2026-09-28T15:12:53Z');
        expect(read!.approvals).toEqual([]);
        expect(read!.markdown).not.toContain('APPROVED');
        const later = await humanReviews(gh, pr, '2026-09-28T15:12:54.000Z');
        expect(later.reviews!.approvals).toHaveLength(1);
    });
});
