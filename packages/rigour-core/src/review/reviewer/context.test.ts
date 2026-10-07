import { describe, expect, it } from 'vitest';
import { dismissedAs, type ReviewDismissal } from './context.js';
import type { OpenItem } from './verdict.js';

const dismissal: ReviewDismissal = { id: 'abcdef0123', file: 'src/x.ts', line: 40, class: 'correctness', issue: 'cache key built from user id may collide', reason: 'ids are unique per tenant', at: '2026-10-06' };
const finding = (over: Partial<OpenItem>): OpenItem => ({ id: 'ffff000011', kind: 'finding', class: 'correctness', file: 'src/x.ts', line: 40, issue: 'cache key built from the user id may collide', consequence: 'two users share an entry', ...over });

describe('a dismissal', () => {
    it('covers the same finding re-worded nearby', () => {
        expect(dismissedAs(finding({}), [dismissal])).toBe(dismissal);
        expect(dismissedAs(finding({ line: 42, issue: 'the cache key built from user id may collide' }), [dismissal])).toBe(dismissal);
        expect(dismissedAs(finding({ id: 'abcdef0123', issue: 'anything at all' }), [dismissal])).toBe(dismissal); // its own id
    });

    it('never hides a different bug, even on the same line and in the same class', () => {
        expect(dismissedAs(finding({ issue: 'cache entry never invalidated when the user changes' }), [dismissal])).toBeUndefined();
        expect(dismissedAs(finding({ line: 42, issue: 'cache entry never invalidated when user id changes' }), [dismissal])).toBeUndefined();
        expect(dismissedAs(finding({ line: 80 }), [dismissal])).toBeUndefined(); // far away
        expect(dismissedAs(finding({ class: 'production-cost' }), [dismissal])).toBeUndefined();
        expect(dismissedAs({ ...finding({}), kind: 'prior' }, [dismissal])).toBeUndefined(); // a human's point is never dismissed this way
    });
});
