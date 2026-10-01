import { describe, expect, it } from 'vitest';
import { readsStdinDiff } from './review.js';

const stat = (kind: 'fifo' | 'file' | 'socket' | 'tty') => ({
    isFIFO: () => kind === 'fifo',
    isFile: () => kind === 'file',
});

describe('readsStdinDiff', () => {
    it('reads a piped or redirected diff when no other source is named', () => {
        expect(readsStdinDiff({}, stat('fifo'))).toBe(true);  // git diff | rigour review
        expect(readsStdinDiff({}, stat('file'))).toBe(true);  // rigour review < change.patch
    });

    it('never waits on a socket or terminal an agent left open', () => {
        expect(readsStdinDiff({}, stat('socket'))).toBe(false);
        expect(readsStdinDiff({}, stat('tty'))).toBe(false);
        expect(readsStdinDiff({}, undefined)).toBe(false);
    });

    it('ignores stdin once --base or --files names the change', () => {
        expect(readsStdinDiff({ base: 'origin/main' }, stat('fifo'))).toBe(false);
        expect(readsStdinDiff({ files: 'src/a.ts' }, stat('file'))).toBe(false);
    });
});
