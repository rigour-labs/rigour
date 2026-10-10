import { describe, expect, it } from 'vitest';
import { notARequest } from './requests.js';

describe('a review point that asks for nothing', () => {
    it('is skipped, with why: a review tool status, a description of the change, praise, a status report', () => {
        expect(notARequest('### 🟡 Changes recommended')).toBe('review tool status');
        expect(notARequest('**Files reviewed:** 12/12 changed files')).toBe('review tool status');
        expect(notARequest('Pull request overview')).toBe('review tool status');
        expect(notARequest('*Once you\'ve addressed the issues the reviewer identified, you can request another review.*')).toBe('review tool status');
        expect(notARequest('- Adds caching for the settings page.')).toBe('describes the change');
        expect(notARequest('Updates schemas, clients, and test coverage.')).toBe('describes the change');
        expect(notARequest('LGTM, thanks for the quick turnaround!')).toBe('praise or thanks');
        expect(notARequest('The retry bound here is correct.')).toBe('praise or thanks');
        expect(notARequest('All 214 tests passing on the latest push.')).toBe('status report');
        expect(notARequest('Lint went from 12 warnings to 0.')).toBe('status report');
        expect(notARequest('Base branch stays main for this one.')).toBe('status report');
    });

    it('is kept whenever it may ask for something: an instruction, a modal, a question, a contrast, or a named defect', () => {
        expect(notARequest('Add the 403 response to the public contract.')).toBeUndefined();
        expect(notARequest('Adds a second cache, but nothing evicts it: bound it.')).toBeUndefined();
        expect(notARequest('Looks good, but should this retry be bounded?')).toBeUndefined();
        expect(notARequest('Thanks! Could you also cover the empty list?')).toBeUndefined();
        expect(notARequest('Tests pass, but the timeout is too short for CI runners.')).toBeUndefined();
        expect(notARequest('The cache is never invalidated after a config reload.')).toBeUndefined();
        expect(notARequest('Stale entries can be served after a config reload.')).toBeUndefined();
        expect(notARequest('Missing lock in refreshCache: it reads the map without holding mu.')).toBeUndefined();
        expect(notARequest('')).toBeUndefined();
    });
});
