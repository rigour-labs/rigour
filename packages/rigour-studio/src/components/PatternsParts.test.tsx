import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IndexShape, IndexTable, type PatternsData } from './PatternsParts';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

const entries = Array.from({ length: 5200 }, (_, i) => ({
    name: `handler${i}`, type: i % 4 === 0 ? 'type' : i % 4 === 1 ? 'component' : 'function', file: `packages/acme-web/src/features/area-${i % 40}/deeply/nested/module-${i}.ts`, line: i + 1, exported: i % 2 === 0,
}));
const index: PatternsData['index'] = {
    indexed: true, lastIndexed: '2026-10-15T09:00:00Z', total: 9358, files: 1200, byType: [{ type: 'function', count: 4679 }, { type: 'type', count: 2340 }, { type: 'component', count: 2339 }], topFiles: [], entries, more: 9358 - 5200, meaning: 'on',
};

describe('the function index', () => {
    it('pages every entry the loader sent, counts kinds over the whole index, and says search covers only what was sent', () => {
        const out = html(<IndexTable index={index} />);
        expect(out).toContain('1–25 of 5,200');
        expect(out).toContain('search and filters cover the first 5,200 of 9,358 entries, not the whole index');
        expect(out).toContain('aria-pressed="true" class="on">All<span class="ui-filterchip-count">9,358</span>');
        expect(out).toContain('>function<span class="ui-filterchip-count">4,679</span>');
        expect(out.match(/<tr>/g)).toHaveLength(26);
    });

    it('fits its card: fixed columns, the file whole on hover, exported as a chip or a dash', () => {
        const out = html(<IndexTable index={index} />);
        expect(out).toContain('<table class="ui-table fixed"><colgroup><col style="width:30%"/><col style="width:120px"/><col/><col style="width:104px"/></colgroup>');
        expect(out).toContain('title="packages/acme-web/src/features/area-0/deeply/nested/module-0.ts:1"');
        expect(out).toContain('>exported</span>');
        expect(out).toContain('aria-label="not exported">—</span>');
    });

    it('filters by kind and search together', () => {
        expect(html(<IndexTable index={index} />)).toContain('>type<span class="ui-filterchip-count">2,340</span>');
        expect(html(<IndexTable index={index} initialQuery="area-3/ module-3.ts" />)).toContain('1 entry · ');
        expect(html(<IndexTable index={index} initialQuery="handler5199" />)).toContain('1 entry');
    });
});

describe('counts', () => {
    it('use the same thousands separators as the numbers above them', () => {
        const out = html(<IndexShape index={{ ...index, byType: [{ type: 'function', count: 2808 }], topFiles: [{ file: 'a.ts', count: 1200 }] }} />);
        expect(out).toContain('<span>2,808</span>');
        expect(out).toContain('<span>1,200</span>');
    });
});
