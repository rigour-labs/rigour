import { describe, expect, it } from 'vitest';
import { lessonsFromReview } from './lessons.js';
import { bodyPoints } from './review-points.js';

const BLOCKING = [
    '### Blocking',
    '',
    '**1. The retry window is unbounded**',
    'Bound it at both ends: `updated_at` between since and until, or a rerun replays a week of jobs.',
    '',
    '**B2: `scheduleRetry` swallows the error.** Rethrow after logging; the caller decides.',
    '',
    '### B3: `laterActionHeld`',
    'Keep the later action held until the earlier one settles, or the two race.',
].join('\n');

const learn = (body: string) => {
    const skipped: string[] = [];
    const kept = lessonsFromReview({ id: '5', prNumber: 8, commit: 'c', body, author: 'lead', source: 'person', prAuthor: 'dev' }, [], undefined, why => skipped.push(why)).map(l => l.text);
    return { kept, skipped };
};

describe('a review body\'s bold and heading blocks', () => {
    it('are points: the lead, and the first sentence under it when the lead is short, a label or an identifier', () => {
        expect(bodyPoints(BLOCKING)).toEqual([
            'The retry window is unbounded. Bound it at both ends: `updated_at` between since and until, or a rerun replays a week of jobs.',
            '`scheduleRetry` swallows the error. Rethrow after logging; the caller decides.',
            '`laterActionHeld`: Keep the later action held until the earlier one settles, or the two race.',
        ]);
        expect(learn(BLOCKING)).toEqual({ kept: bodyPoints(BLOCKING), skipped: [] });
    });

    it('keeps a long lead as it is, and takes only the sentence after a severity label', () => {
        expect(bodyPoints('**The export loads every invoice line into memory before it filters by tenant**\nStream it instead.'))
            .toEqual(['The export loads every invoice line into memory before it filters by tenant']);
        expect(bodyPoints('**Must fix:** Close the cursor when the batch is empty. It leaks otherwise.')).toEqual(['Close the cursor when the batch is empty.']);
    });

    it('never reads a section name as a point: a severity heading, or a heading a list follows', () => {
        expect(bodyPoints('## Should fix\n\n**Nits**\n\n### Round two\n- Rename `flushAll` to say it drops the queue.')).toEqual(['Rename `flushAll` to say it drops the queue.']);
        expect(bodyPoints('### Non-blocking\n\nA sentence of context with nothing to ask.')).toEqual([]);
    });

    it('keeps bullets and blocks together in body order', () => {
        const body = '- Cap the batch size at the queue limit.\n\n**2. The worker never acks a poisoned message**\nAck it after moving it to the dead-letter queue.\n\n- Log the message id on every retry.';
        expect(bodyPoints(body)).toEqual([
            'Cap the batch size at the queue limit.',
            'The worker never acks a poisoned message. Ack it after moving it to the dead-letter queue.',
            'Log the message id on every retry.',
        ]);
    });

    it('keeps a bold label inside a block part of that block, and ignores headings in a code fence', () => {
        expect(bodyPoints('**1. The poller drifts**\n**Why:** each tick adds its own run time.\n\n```sh\n# Retry the job twice\nrun-job --retry\n```')).toEqual(['The poller drifts. Why: each tick adds its own run time.']);
    });
});

describe('a review body\'s bullets, by the section they sit in', () => {
    it('skips a praise list as praise and a list of what was fixed since the last round as a status report', () => {
        const body = '### What\'s good\n- The parser handles empty input cleanly.\n- Clear names throughout the queue module.\n\nFixed since the last round:\n- The cursor now resets on reconnect.\n- Tests cover the empty batch.\n\n### Blocking\n- The lock is taken twice on the retry path.';
        expect(learn(body)).toEqual({
            kept: ['The lock is taken twice on the retry path.'],
            skipped: ['praise or thanks', 'praise or thanks', 'status report', 'status report'],
        });
    });

    it('keeps a bullet under a praise or status heading that asks for something', () => {
        expect(learn('**Addressed:**\n- The cursor resets now, but the reconnect test should cover a dropped socket.').kept)
            .toEqual(['The cursor resets now, but the reconnect test should cover a dropped socket.']);
    });

    it('still skips a change-summary list as a description', () => {
        expect(learn('## Summary of changes\n- Splits the parser into two files.\n- Moves the retry policy into its own module.')).toEqual({ kept: [], skipped: ['describes the change', 'describes the change'] });
    });
});
