import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckPrecision, PrecisionRow } from './CheckPrecision';

describe('CheckPrecision', () => {
    it('shows a check with its posterior, its counts, and whether it is muted', () => {
        const html = renderToStaticMarkup(<PrecisionRow row={{ check: 'ast: Too many parameters', fixed: 0, dismissed: 6, precision: 0.125, muted: true }} />);
        expect(html).toContain('13%');
        expect(html).toContain('ast: Too many parameters');
        expect(html).toContain('0 fixed · 6 dismissed');
        expect(html).toContain('muted');
    });

    it('does not mark an unmuted check', () => {
        const html = renderToStaticMarkup(<PrecisionRow row={{ check: 'semantic-bugs: Unbounded read', fixed: 4, dismissed: 0, precision: 5 / 6, muted: false }} />);
        expect(html).not.toContain('muted');
        expect(html).toContain('83%');
    });

    it('renders its heading before data arrives', () => {
        expect(renderToStaticMarkup(<CheckPrecision />)).toContain('Check precision');
    });
});
