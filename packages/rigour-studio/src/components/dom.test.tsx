// @vitest-environment jsdom
/**
 * What only a browser shows: measuring clamped text, keys on a one-line clamp and on the pager, copying a fix command,
 * and the navigation rail's toggle. Rendered into jsdom with React's act.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Clamp, FilterBar, Pager, usePaged } from './readable';
import { FixCommand } from './ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A Storage of our own: newer Node puts its own `localStorage` global, unset without a file, over jsdom's. */
class MemoryStorage {
    private items = new Map<string, string>();
    get length() { return this.items.size; }
    clear() { this.items.clear(); }
    getItem(k: string) { return this.items.get(k) ?? null; }
    setItem(k: string, v: string) { this.items.set(k, String(v)); }
    removeItem(k: string) { this.items.delete(k); }
    key(i: number) { return [...this.items.keys()][i] ?? null; }
}
Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });

let container: HTMLDivElement;
let root: Root;
const render = (node: React.ReactElement) => act(() => { root.render(node); });
const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const $ = (selector: string) => container.querySelector(selector) as HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.localStorage.clear();
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** jsdom lays nothing out: each test says how tall the clamped text is, against the box it is clamped to. */
function layout(scrollHeight: number, clientHeight: number): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

describe('Clamp, measured', () => {
    it('offers Show more when short text still runs past its lines, as measured', async () => {
        layout(90, 44);
        await render(<Clamp text="A short line that wraps in a narrow column." />);
        expect($('.ui-clamp-toggle').textContent).toBe('Show more');
        await click($('.ui-clamp-toggle'));
        expect($('.ui-clamp-toggle').getAttribute('aria-expanded')).toBe('true');
        expect($('.ui-clamp-text').className).toBe('ui-clamp-text');
    });

    it('drops the guess when long text fits, as measured', async () => {
        layout(44, 44);
        await render(<Clamp text={'word '.repeat(80)} />);
        expect($('.ui-clamp-toggle')).toBeNull();
    });

    it('opens a one-line clamp with Enter and closes it with Space, from the line itself', async () => {
        layout(40, 22);
        await render(<Clamp text="checkout.retry: Retry the payment call twice with backoff, then fail the checkout." lines={1} />);
        const line = $('.ui-clamp-line');
        expect(line.getAttribute('role')).toBe('button');
        expect(line.getAttribute('aria-expanded')).toBe('false');
        await key(line, 'Enter');
        expect(line.getAttribute('aria-expanded')).toBe('true');
        await key(line, ' ');
        expect(line.getAttribute('aria-expanded')).toBe('false');
        expect(container.textContent).not.toContain('Show more');
    });
});

const Listing: React.FC = () => {
    const [query, setQuery] = React.useState('');
    const items = Array.from({ length: 120 }, (_, i) => `entry ${i}`).filter(s => s.includes(query));
    const paged = usePaged(items, { resetKey: query, storageKey: 'test:listing' });
    return <><FilterBar query={query} onQuery={setQuery} placeholder="Search entries" matching={items.length} /><Pager paged={paged} label="entries" /></>;
};

describe('Pager keys', () => {
    it('pages with the arrow keys inside the pager, and not while someone types in the search box', async () => {
        await render(<Listing />);
        const count = () => $('.ui-pager-count').textContent;
        expect(count()).toBe('1–25 of 120');
        await key($('[aria-label="Next page"]'), 'ArrowRight');
        expect(count()).toBe('26–50 of 120');
        await key($('[aria-label="Next page"]'), 'ArrowLeft');
        expect(count()).toBe('1–25 of 120');
        await key($('input[type="search"]'), 'ArrowRight');
        expect(count()).toBe('1–25 of 120');
        await key($('.ui-pager select'), 'ArrowRight');
        expect(count()).toBe('1–25 of 120');
    });

    it('accepts only 25, 50 or 100 as a remembered page size', async () => {
        window.localStorage.setItem('rigour-studio:test:listing:size', '7');
        await render(<Listing />);
        expect($('.ui-pager-count').textContent).toBe('1–25 of 120');
    });
});

describe('FixCommand copying', () => {
    const raw = 'claude mcp add --scope user rigour -- node /Users/dev-a/work/acme/mcp/dist/index.js';

    it('copies the raw command, shows ~ for the home folder, and reads Copy again after two seconds', async () => {
        vi.useFakeTimers();
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await render(<FixCommand command={raw} />);
        expect($('.ui-fix-code').textContent).toContain('node ~/work/acme');
        await act(async () => { $('.ui-fix-copy').click(); });
        expect(writeText).toHaveBeenCalledWith(raw);
        expect($('.ui-fix-copy').textContent).toBe('Copied');
        await act(async () => { vi.advanceTimersByTime(2100); });
        expect($('.ui-fix-copy').textContent).toBe('Copy');
    });

    it('falls back to a hidden text area when the clipboard API refuses', async () => {
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
        let copied = '';
        Object.defineProperty(document, 'execCommand', { value: () => { copied = document.querySelector('textarea')?.value ?? ''; return true; }, configurable: true });
        await render(<FixCommand command={raw} />);
        await act(async () => { $('.ui-fix-copy').click(); });
        expect(copied).toBe(raw);
        expect($('.ui-fix-copy').textContent).toBe('Copied');
        expect(document.querySelector('textarea')).toBeNull();
    });
});

describe('remembered choices', () => {
    it('are kept per repository, except how the navigation shows', async () => {
        const { setStorageRepository, usePersisted } = await import('./readable');
        const Choice: React.FC = () => {
            const [tab, setTab] = usePersisted<string>('memory:tab', 'lessons');
            const [nav, setNav] = usePersisted<string>('nav', 'rail', true);
            return <><button id="tab" onClick={() => setTab('rules')}>{tab}</button><button id="nav" onClick={() => setNav('full')}>{nav}</button></>;
        };
        setStorageRepository('acme-shop');
        await render(<Choice />);
        await click($('#tab'));
        await click($('#nav'));
        expect(window.localStorage.getItem('rigour-studio:acme-shop:memory:tab')).toBe('rules');
        expect(window.localStorage.getItem('rigour-studio:nav')).toBe('full');
        setStorageRepository(undefined);
    });
});

describe('the navigation rail', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/info'
            ? new Response(JSON.stringify({ projectName: 'acme-shop', branch: 'main' }), { status: 200 })
            : new Response(JSON.stringify({ error: 'not in this test' }), { status: 500 }))));
        vi.stubGlobal('EventSource', class { onopen = null; onerror = null; onmessage = null; close() { /* nothing open */ } });
        vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 960px)', addEventListener: () => undefined, removeEventListener: () => undefined }));
    });
    afterEach(() => vi.unstubAllGlobals());

    it('folds to icons at 960px, opens with its toggle, says so with aria-expanded, and remembers it', async () => {
        const { default: App } = await import('../App');
        await act(async () => { root.render(<App />); });
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        const toggle = () => $('.nav-toggle');
        const memory = () => container.querySelector('nav button[aria-label="Memory"]') as HTMLElement;
        expect($('.studio').dataset.nav).toBe('rail');
        expect(toggle().getAttribute('aria-expanded')).toBe('false');
        expect(toggle().getAttribute('aria-controls')).toBe('studio-nav');
        expect(memory().getAttribute('title')).toBe('Memory');
        await click(toggle());
        expect(toggle().getAttribute('aria-expanded')).toBe('true');
        expect(toggle().getAttribute('aria-label')).toBe('Hide page names');
        expect(memory().getAttribute('title')).toBeNull();
        expect(window.localStorage.getItem('rigour-studio:nav')).toBe('full');
        act(() => root.unmount());
        root = createRoot(container);
        await act(async () => { root.render(<App />); });
        expect(toggle().getAttribute('aria-expanded')).toBe('true');
    });
});
