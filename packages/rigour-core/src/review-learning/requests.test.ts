import { describe, expect, it } from 'vitest';
import { lessonsFromReview } from './lessons.js';
import { notARequest } from './requests.js';

describe('a review point that asks for nothing', () => {
    it('is skipped, with why: a review tool status, a description of the change, praise, a status report', () => {
        expect(notARequest('### 🟡 Changes recommended', 'body')).toBe('review tool status');
        expect(notARequest('**Files reviewed:** 12/12 changed files', 'body')).toBe('review tool status');
        expect(notARequest('Pull request overview', 'body')).toBe('review tool status');
        expect(notARequest('*Once you\'ve addressed the issues the reviewer identified, you can request another review.*', 'body')).toBe('review tool status');
        expect(notARequest('- Adds caching for the settings page.', 'body')).toBe('describes the change');
        expect(notARequest('Updates schemas, clients, and test coverage.', 'body')).toBe('describes the change');
        expect(notARequest('LGTM, thanks for the quick turnaround!', 'body')).toBe('praise or thanks');
        expect(notARequest('The retry bound here is correct.', 'body')).toBe('praise or thanks');
        expect(notARequest('All 214 tests passing on the latest push.', 'body')).toBe('status report');
        expect(notARequest('Lint went from 12 warnings to 0.', 'body')).toBe('status report');
        expect(notARequest('Base branch stays main for this one.', 'body')).toBe('status report');
    });

    it('is kept whenever it may ask for something: an instruction, a modal, a question, a contrast, or a named defect', () => {
        expect(notARequest('Add the 403 response to the public contract.', 'body')).toBeUndefined();
        expect(notARequest('Adds a second cache, but nothing evicts it: bound it.', 'body')).toBeUndefined();
        expect(notARequest('Looks good, but should this retry be bounded?', 'body')).toBeUndefined();
        expect(notARequest('Thanks! Could you also cover the empty list?', 'body')).toBeUndefined();
        expect(notARequest('Tests pass, but the timeout is too short for CI runners.', 'body')).toBeUndefined();
        expect(notARequest('The cache is never invalidated after a config reload.', 'body')).toBeUndefined();
        expect(notARequest('Stale entries can be served after a config reload.', 'body')).toBeUndefined();
        expect(notARequest('Missing lock in refreshCache: it reads the map without holding mu.', 'body')).toBeUndefined();
        expect(notARequest('', 'body')).toBeUndefined();
    });

    it('reads a third-person sentence on a line as a stated defect, kept, and the same sentence in a review body as an overview, skipped', () => {
        for (const said of ['Loads every row into memory on each request.', 'Reads the token from localStorage.', 'Uses the stale cache after logout.']) {
            expect(notARequest(said, 'inline')).toBeUndefined();
            expect(notARequest(`- ${said}`, 'body')).toBe('describes the change');
        }
        // Everything else reads the same on a line and in a body.
        expect(notARequest('LGTM, thanks!', 'inline')).toBe('praise or thanks');
        expect(notARequest('All 214 tests passing on the latest push.', 'inline')).toBe('status report');
    });
});


describe('a review body read by its structure', () => {
    const review = (body: string) => ({ id: '9', prNumber: 3, commit: 'c', body, author: 'review-helper[bot]', source: 'bot' as const, prAuthor: 'dev' });
    const learn = (body: string) => {
        const skipped: string[] = [];
        const kept = lessonsFromReview(review(body), [], undefined, why => skipped.push(why)).map(l => l.text);
        return { kept, skipped };
    };

    it('reads the list under a change-summary heading as a description, whatever its verbs, and keeps a finding under another heading', () => {
        const { kept, skipped } = learn('### Changes recommended\n\n**Changes:**\n- Bridges the old and new role types.\n- Converts six license fields into table rows.\n- Opens the setup page in a new tab.\n\n### Findings\n- The retry loop never stops on a permanent error.');
        expect(skipped).toEqual(['describes the change', 'describes the change', 'describes the change']);
        expect(kept).toEqual(['The retry loop never stops on a permanent error.']);
    });

    it('reads a collapsed block about the tool itself as tool status, imperatives and all', () => {
        const { kept, skipped } = learn('### Automated review\n\n<details> <summary>About ReviewBot in GitHub</summary>\n\nReviews are triggered when you\n- Open a pull request for review\n- Mark a draft as ready\n</details>');
        expect(skipped).toEqual(['review tool status', 'review tool status']);
        expect(kept).toEqual([]);
    });

    it('keeps findings in a collapsed block that is not about the tool, and a summary bullet that asks for something', () => {
        expect(learn('<details>\n<summary>Review details</summary>\n\n### Suppressed comments (1)\n* This loop has no upper bound; cap the retries.\n</details>').kept)
            .toEqual(['This loop has no upper bound; cap the retries.']);
        const { kept, skipped } = learn('## Summary\n- Please add a test for the empty list.\n- Splits the parser into two files.');
        expect(kept).toEqual(['Please add a test for the empty list.']);
        expect(skipped).toEqual(['describes the change']);
    });
});
