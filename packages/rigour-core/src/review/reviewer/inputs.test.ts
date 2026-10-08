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

    it('reads the bullets and numbered lines under Blocking / Should fix / Nits headings as that reviewer labelled them, and nothing under another heading', async () => {
        const body = ['Thanks, a few things.', '', '## Blocking', '- The kill switch is read after every query: check it first.', '',
            '**Should fix**', '1. The comment on the window still says daily.', '', 'Nits:', '* Rename tmp to rows.', '', '## Context', '- not a label'].join('\n');
        const labelled = async (args: string[]) => ({ exitCode: 0, stdout: JSON.stringify(args[1].endsWith('/reviews') ? [{ ...reviews[0], body }] : []), stderr: '' });
        const { reviews: read } = await humanReviews(labelled, pr, undefined);
        expect(read!.labels.map(l => [l.login, l.severity, l.text])).toEqual([
            ['senior', 'blocking', 'The kill switch is read after every query: check it first.'],
            ['senior', 'should-fix', 'The comment on the window still says daily.'],
            ['senior', 'non-blocking', 'Rename tmp to rows.'],
        ]);
        expect(read!.labels.every(l => l.at === '2026-09-25T18:09:11Z')).toBe(true);
    });

    it('reads a numbered point set in bold, with its evidence sub-bullets, under each heading', async () => {
        const body = ['## Blocking', '', '**1. The status column is typed nullable but the table declares it NOT NULL.**', '- the reader falls back to an empty string', '- two callers check for null again', '',
            '**2. The retry posts the event twice when the first post times out.**', '', '## Should fix', '', '__1. The window comment says hourly; the job runs daily.__', '', '## Nits', '', '- Rename tmp to rows.'].join('\n');
        const shaped = async (args: string[]) => ({ exitCode: 0, stdout: JSON.stringify(args[1].endsWith('/reviews') ? [{ ...reviews[0], body }] : []), stderr: '' });
        const { reviews: read } = await humanReviews(shaped, pr, undefined);
        expect(read!.labels.map(l => [l.severity, l.text])).toEqual([
            ['blocking', 'The status column is typed nullable but the table declares it NOT NULL.'],
            ['blocking', 'the reader falls back to an empty string'],
            ['blocking', 'two callers check for null again'],
            ['blocking', 'The retry posts the event twice when the first post times out.'],
            ['should-fix', 'The window comment says hourly; the job runs daily.'],
            ['non-blocking', 'Rename tmp to rows.'],
        ]);
    });
});
