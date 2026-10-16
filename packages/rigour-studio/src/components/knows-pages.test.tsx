import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LessonCard, type Journey } from './LearningParts';
import { FromReviews, RememberedTable, memoryKpis } from './MemoryParts';
import { HowMemoryWorks, JourneyCard } from './MemoryStore';
import { IndexShape, IndexTable, RecurringTable, ReuseList, patternKpis, type PatternsData } from './PatternsParts';
import { AgentsGiven, WeeklyTable, type ContextData } from './PatternsContext';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const lesson = (over: Partial<Journey>): Journey => ({
    id: 'l1', text: 'Fixtures use `sk_test_` keys', origin: 'development', learnedFrom: 'A fix while an agent was writing', learnedAt: '2026-10-01T00:00:00Z',
    state: 'validated', scope: 'this repo', told: 2, stoppedInDevelopment: 1, reachedPr: null, canDecide: false, ...over,
});

describe('the Memory page', () => {
    it('leads with lessons in force, lessons briefed, repeats stopped (said to be computed) and what waits on a person', () => {
        const items = memoryKpis([
            lesson({}),
            lesson({ id: 'l2', state: 'candidate', canDecide: true }),
            lesson({ id: 'l3', origin: 'pr', state: 'candidate', canDecide: true, fromBots: true }),
        ], [{ from: '2026-09-25T00:00:00Z', stoppedInDevelopment: 2, reachedPr: null }, { from: '2026-10-02T00:00:00Z', stoppedInDevelopment: 1, reachedPr: null }], { lessons: 7, requests: 3, days: 28 });
        expect(items.map(i => [i.label, i.value])).toEqual([['Lessons in force', 1], ['Briefed to agents, 28 days', 7], ['Repeats stopped', 3], ['Waiting for a person', 1]]);
        expect(html(<>{items[2].note}</>)).toContain('Computed');
        expect(String(items[3].note)).toContain('1 candidate only review bots raised');
        expect(memoryKpis([], [], undefined)[1]).toMatchObject({ value: '—', note: 'Not recorded by this version of Rigour.' });
    });

    it('marks a lesson that contradicts another, and one never given to an agent in 60 days', () => {
        const card = (over: Partial<Journey>) => html(<LessonCard lesson={lesson(over)} onDecide={() => undefined} />);
        const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        expect(card({ told: 0, learnedAt: daysAgo(90) })).toContain('unused 60 days');
        expect(card({ told: 0, learnedAt: daysAgo(10) })).not.toContain('unused');
        expect(card({ told: 0, learnedAt: daysAgo(90), state: 'rejected' })).not.toContain('unused');
        expect(card({ told: 4, learnedAt: daysAgo(90) })).not.toContain('unused');
        const contradicting = card({ conflicts: ['a team lesson in web', 'a personal lesson in api'] });
        expect(contradicting).toContain('learned from a fix while an agent was writing');
        expect(contradicting).toContain('kept on this machine');
        expect(contradicting).toContain('contradicts a team lesson in web and 1 more');
        expect(contradicting).toContain('ui-chip bad');
    });

    it('shows remembered facts with where each is kept and when, and says so when the date was not recorded', () => {
        const out = html(<RememberedTable memories={[['api_base', { value: 'Use https://api.example.com', timestamp: '2026-10-01T00:00:00Z', source: 'project' }], ['global:style', { value: 'Prefer small PRs', source: 'global' }]]} />);
        expect(out).toContain('class="ui-memkey" title="api_base">api_base<');
        expect(out).toContain('title="style">style<');
        expect(out).toContain('kept for this repository');
        expect(out).toContain('kept for you, every repository');
        expect(out).toContain('saved: not recorded');
        expect(out).toContain('aria-pressed="true" class="on">All');
        expect(html(<RememberedTable memories={[]} />)).toContain('rigour_remember');
    });

    it('lists a review lesson\'s trail: who raised it at which PR, and who decided and why', () => {
        const out = html(<FromReviews lessons={[lesson({ id: 'r1', origin: 'pr', state: 'verified', stoppedInDevelopment: null, evidence: [
            { kind: 'point', pr: 12, author: 'reviewer-a', source: 'person', at: '2026-09-01T00:00:00Z' },
            { kind: 'outcome', pr: 12, author: 'git', detail: 'fixed later by abc123' },
            { kind: 'accepted', pr: 12, author: 'lead@example.com', detail: 'how we work' },
            { kind: 'rejected', pr: 12, author: 'reviewer-a', team: true },
            { kind: 'correction', pr: 0, author: 'dev@example.com' },
        ] })]} />);
        expect(out).not.toContain('PR #0');
        expect(out).toContain('Show all 5');
        expect(out).toContain('kept in this repository');
        expect(out).toContain('PR #12');
        expect(out).toContain('<strong>reviewer-a</strong> raised it');
        expect(out).toContain('a later fix or revert backed it<span>: fixed later by abc123</span>');
        expect(out).not.toContain('<strong>git</strong>');
        expect(out).toContain('<strong>lead@example.com</strong> promoted it<span>: how we work</span>');
        expect(out).toContain('<strong>reviewer-a</strong> (team) decided against it');
        expect(html(<FromReviews lessons={[]} />)).toContain('rigour learn-reviews');
    });

    it('walks one lesson from where it was learned to the repeat it stopped', () => {
        const lessons = [lesson({ id: 'quiet', told: 9, stoppedInDevelopment: 0 }), lesson({ id: 'busy', text: 'Bound the window', told: 1, stoppedInDevelopment: 2 })];
        const out = html(<JourneyCard lessons={lessons} />);
        expect(out).toContain('Bound the window'); // the one that stopped repeats, over the one told most
        expect(out).not.toContain('sk_test_');
        expect(out).toContain('Learned');
        expect(out).toContain('Given to an agent once');
        expect(out).toContain('caught again 2 times before a PR (computed by rule and title)');
        expect(html(<JourneyCard lessons={[]} />)).toContain('The first lesson shows here');
    });

    it('says where each kind of memory is kept, with live counts, and that sharing takes a person', () => {
        const out = html(<HowMemoryWorks lessons={[lesson({}), lesson({ id: 'r', origin: 'pr' })]} memories={[['a', { value: 'x', source: 'project' }], ['b', { value: 'y', source: 'global' }], ['c', { value: 'z', source: 'global' }]]} />);
        expect(out).toContain('1 lesson from fixes and memories');
        expect(out).toContain('2 facts you keep for every repository');
        expect(out).toContain('1 lesson from pull request reviews and 1 fact');
        expect(out).toContain('only once a person shares it');
    });
});

const patterns: PatternsData = {
    index: {
        indexed: true, lastIndexed: '2026-10-15T09:00:00Z', total: 3, files: 2,
        byType: [{ type: 'function', count: 2 }, { type: 'interface', count: 1 }], topFiles: [{ file: 'src/money.ts', count: 2 }],
        entries: [
            { name: 'formatCents', type: 'function', file: 'src/money.ts', line: 3, exported: true },
            { name: 'Money', type: 'interface', file: 'src/money.ts', line: 1, exported: true },
            { name: 'loadCart', type: 'function', file: 'src/cart.ts', line: 8, exported: false },
        ],
        more: 0, meaning: 'on',
    },
    recurring: { recorded: true, patterns: [{ pattern: 'security-patterns', description: 'Hardcoded secret: a key in source', timesSeen: 4, strength: 0.75, firstSeen: '2026-09-01T00:00:00Z', lastSeen: '2026-10-10T00:00:00Z', source: 'ast' }] },
    reuse: { days: 28, recent: 1, total: 2, examples: [{ at: '2026-10-10T00:00:00Z', planned: 'formatMoney', existing: 'formatCents in src/money.ts:3', action: 'BLOCK' }] },
};

describe('the Patterns page', () => {
    it('leads with functions indexed, when, recurring problems and reuse, and dashes what is not recorded', () => {
        expect(patternKpis(patterns).map(i => [i.label, i.value])).toEqual([['Functions indexed', '2'], ['Last indexed', expect.any(String)], ['Recurring problems', 1], ['Reuse suggestions, 28 days', 1]]);
        const none = patternKpis({ ...patterns, index: { ...patterns.index, indexed: false, lastIndexed: null }, recurring: { recorded: false, patterns: [] } });
        expect(none.map(i => i.value)).toEqual(['—', '—', '—', 1]);
        expect(String(none[2].note)).toContain('Not recorded');
    });

    it('searches the index by name, kind or file', () => {
        expect(html(<IndexTable index={patterns.index} />).match(/<tr/g)).toHaveLength(4);
        const cart = html(<IndexTable index={patterns.index} initialQuery="cart" />);
        expect(cart).toContain('loadCart');
        expect(cart).not.toContain('formatCents');
        expect(html(<IndexTable index={patterns.index} initialQuery="nothing-like-it" />)).toContain('Nothing in the index matches');
        expect(html(<IndexTable index={{ ...patterns.index, indexed: false }} />)).toContain('rigour index');
        expect(html(<IndexShape index={patterns.index} />)).toContain('Matching by meaning');
    });

    it('lists recurring problems and the code agents were pointed to, and explains each when empty', () => {
        const recurring = html(<RecurringTable recurring={patterns.recurring} />);
        expect(recurring).toContain('security-patterns');
        expect(recurring).toContain('Hardcoded secret');
        expect(recurring).not.toContain('Show all');
        const many = { recorded: true, patterns: Array.from({ length: 12 }, (_, i) => ({ ...patterns.recurring.patterns[0], pattern: `kind-${i}` })) };
        const top = html(<RecurringTable recurring={many} />);
        expect(top).toContain('Show all 12');
        expect(top).not.toContain('kind-10');
        expect(html(<RecurringTable recurring={{ recorded: false, patterns: [] }} />)).toContain('Not recorded');
        expect(html(<RecurringTable recurring={{ recorded: true, patterns: [] }} />)).toContain('counts once per kind of problem');
        const reuse = html(<ReuseList reuse={patterns.reuse} />);
        expect(reuse).toContain('About to write <span class="ui-mono">formatMoney</span>; pointed to');
        expect(reuse).toContain('told to reuse');
        expect(html(<ReuseList reuse={{ days: 28, recent: 0, total: 0, examples: [] }} />)).toContain('rigour_check_pattern');
    });

    it('folds in what agents were given, and leaves quiet weeks out of the context table', () => {
        const quiet = { from: '2026-09-25T00:00:00Z', scopes: 0, filesReturned: 0, filesConsidered: 0, recalls: 0, lessonsTold: 0, reuse: 0 };
        expect(html(<WeeklyTable weeks={[quiet]} />)).toContain('No context requests in the last 8 weeks.');
        const busy = html(<WeeklyTable weeks={[quiet, { ...quiet, from: '2026-10-02T00:00:00Z', scopes: 2, filesReturned: 9, filesConsidered: 300 }]} />);
        expect(busy).toContain('9 of 300');
        expect(busy.match(/<tr/g)).toHaveLength(2); // header and the one active week
        const week: ContextData['week'] = { scopes: 1, filesConsidered: 180, filesReturned: 6, tokensConsidered: 90000, tokensReturned: 4000, recalls: 1, lessonsTold: 3, reuse: [] };
        const given = html(<AgentsGiven data={{ week, weeks: [] }} />);
        expect(given).toContain('6 files instead of 180');
        expect(given).toContain('About 4k tokens returned out of 90k considered');
        expect(html(<AgentsGiven data={{ week: { ...week, scopes: 0, recalls: 0, lessonsTold: 0 }, weeks: [] }} />)).toContain('No agent asked Rigour for context this week.');
    });
});
