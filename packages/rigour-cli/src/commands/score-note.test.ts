import { describe, expect, it } from 'vitest';
import { scoreNote } from './score-note.js';

describe('the score, explained', () => {
    it('says what a score below 100 counts, with the weights it is computed with', () => {
        expect(scoreNote(62)).toBe('Score 62/100 counts every finding in the files checked, notes included (critical 20, high 10, medium 5, low 2 points each, capped per check).');
        expect(scoreNote(62, true)).toContain('; only the findings to fix decide the verdict.');
    });

    it('says nothing at 100 or with no score', () => {
        expect(scoreNote(100)).toBeUndefined();
        expect(scoreNote(undefined)).toBeUndefined();
    });
});
