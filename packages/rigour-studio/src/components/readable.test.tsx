import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Clamp, FilterBar, MemoryText, Pager, matchesQuery, usePaged } from './readable';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const long = 'Retry the payment call with backoff before failing the checkout. '.repeat(6);

describe('Clamp', () => {
    it('clamps long text to its lines and offers Show more as a real button tied to the text', () => {
        const out = html(<Clamp text={long} lines={2} />);
        expect(out).toContain('ui-clamp-text clamped');
        expect(out).toContain('-webkit-line-clamp:2');
        expect(out).toMatch(/<button type="button" class="ui-clamp-toggle" aria-expanded="false" aria-controls="[^"]+">Show more<\/button>/);
    });

    it('shows short text whole, with no button', () => {
        const out = html(<Clamp text="Use withRetry." />);
        expect(out).toContain('Use withRetry.');
        expect(out).not.toContain('<button');
    });
});

describe('MemoryText', () => {
    it('shows a key: value as a monospace key with its whole text on hover, and the value clamped', () => {
        const out = html(<MemoryText text={`payments.retry_policy: ${long}`} />);
        expect(out).toContain('class="ui-memkey" title="payments.retry_policy">payments.retry_policy</div>');
        expect(out).toContain('Show more');
        expect(out).not.toContain('payments.retry_policy: Retry');
    });

    it('takes a key it is given, and leaves other text whole', () => {
        expect(html(<MemoryText text="x" memoryKey="api_base" value="https://api.example.com" />)).toContain('title="api_base"');
        const plain = html(<MemoryText text="Hardcoded secret: a key in source" />);
        expect(plain).not.toContain('ui-memkey');
        expect(plain).toContain('Hardcoded secret: a key in source');
    });

    it('reads one identifier as a key, never a capitalised word or a phrase', () => {
        expect(html(<MemoryText text="retries: three, then fail" />)).toContain('title="retries">retries</div>');
        expect(html(<MemoryText text="Note: a sentence" />)).not.toContain('ui-memkey');
        expect(html(<MemoryText text="Close the handle: always" />)).not.toContain('ui-memkey');
    });
});

const Paging: React.FC<{ count: number }> = ({ count }) => {
    const paged = usePaged(Array.from({ length: count }, (_, i) => i), { storageKey: 'test:paging' });
    return <><span data-items={paged.items.join(',')} /><Pager paged={paged} label="entries" /></>;
};

/**
 * A person's steps, replayed while rendering: each step runs once, before the render that shows it, and `seen` keeps
 * which page each render showed. Render-phase updates re-render the same component, so the hooks keep their state.
 */
const Steps: React.FC<{ steps: Array<(s: { page: (n: number) => void; filter: (key: string) => void }) => void>; count: number; seen: number[] }> = ({ steps, count, seen }) => {
    const [filter, setFilter] = React.useState('all');
    const done = React.useRef(0);
    const paged = usePaged(Array.from({ length: count }, (_, i) => i), { resetKey: filter, storageKey: 'test:steps' });
    seen.push(paged.page);
    if (done.current < steps.length) steps[done.current++]({ page: paged.setPage, filter: setFilter });
    return <span>{paged.page}</span>;
};

describe('Pager', () => {
    it('says which items show of how many, with Previous, Next, First, Last and a page size', () => {
        const out = html(<Paging count={9358} />);
        expect(out).toContain('1–25 of 9,358');
        expect(out).toContain('Page 1 of 375');
        expect(out).toContain('aria-label="First page"');
        expect(out).toContain('aria-label="Last page"');
        expect(out).toMatch(/disabled="" aria-label="Previous page"/);
        expect(out).toContain('<option value="25" selected="">25</option><option value="50">50</option><option value="100">100</option>');
        expect(out).toContain('data-items="0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24"');
    });

    it('shows nothing for a list that fits on one page, and no First or Last for a few pages', () => {
        expect(html(<Paging count={25} />)).not.toContain('ui-pager');
        expect(html(<Paging count={60} />)).not.toContain('First page');
    });

    it('goes back to page 1 when the filter or search changes, and stays there on going back to the earlier one', () => {
        const seen: number[] = [];
        const out = html(<Steps count={200} seen={seen} steps={[s => s.page(4), s => s.filter('waiting'), s => s.filter('all')]} />);
        expect(seen).toContain(4);
        expect(seen[seen.length - 1]).toBe(1);
        expect(out).toBe('<span>1</span>');
    });

    it('keeps a chosen page within the list', () => {
        const seen: number[] = [];
        expect(html(<Steps count={30} seen={seen} steps={[s => s.page(9)]} />)).toBe('<span>2</span>');
    });
});

describe('FilterBar', () => {
    it('has a labelled search, chips that say which is pressed with their counts, and how many match', () => {
        const out = html(<FilterBar query="" onQuery={() => undefined} placeholder="Search lessons" chips={[{ id: 'a', label: 'All', count: 1200 }, { id: 'w', label: 'Waiting', count: 3 }]} active="w" matching={3} noun={['lesson', 'lessons']} />);
        expect(out).toContain('aria-label="Search lessons"');
        expect(out).toContain('aria-pressed="false" class="">All<span class="ui-filterchip-count">1,200</span>');
        expect(out).toContain('aria-pressed="true" class="on">Waiting');
        expect(out).toContain('3 lessons');
        expect(html(<FilterBar query="" onQuery={() => undefined} placeholder="Search" matching={1} noun={['lesson', 'lessons']} />)).toContain('1 lesson<');
    });

    it('matches every word of a search, in any order and case', () => {
        expect(matchesQuery('payments.retry_policy: Retry with backoff', 'BACKOFF retry')).toBe(true);
        expect(matchesQuery('payments.retry_policy', 'retry cache')).toBe(false);
        expect(matchesQuery('anything', '  ')).toBe(true);
    });
});
