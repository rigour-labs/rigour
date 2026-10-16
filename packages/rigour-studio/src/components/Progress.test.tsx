import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Trend } from './Progress';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('a quiet trend, on the Progress page', () => {
    it('is one line instead of a row of zero bars', () => {
        const weeks = [{ from: '2026-10-02T00:00:00Z', stopped: 0, overruled: 0, repeatsStopped: 0, repeatsReachedPr: null, minutesToFix: null, lessons: 0 }];
        const out = html(<Trend title="Overruled" hint="findings someone marked not a bug" weeks={weeks} value={w => w.overruled} />);
        expect(out).toContain('st-trend-flat');
        expect(out).toContain('none in the last 1 week');
        expect(out).not.toContain('st-bars');
    });
});
