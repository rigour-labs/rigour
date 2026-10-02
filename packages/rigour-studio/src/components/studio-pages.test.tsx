import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionCard } from './Activity';
import { WeeklyTable } from './AgentContext';
import { LessonCard } from './Learning';
import { Trend } from './Progress';
import { inlineCode, plural } from './storyData';
import { StoryCard } from './Week';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Studio pages', () => {
    it('summarises a session and lists only what mattered until asked', () => {
        const out = html(<SessionCard session={{
            start: '2026-10-02T08:16:00Z', end: '2026-10-02T10:32:00Z',
            counts: { stopped: 1, fixed: 0, checked: 26, reviewed: 15, taught: 0, pr: 0, reviewedFixed: 3 },
            highlights: [{ at: '2026-10-02T10:00:00Z', kind: 'reviewed', text: 'Fixed `api` in scripts/a.mjs', detail: 'redirect: "error" now' }],
            rest: [{ at: '2026-10-02T09:00:00Z', kind: 'checked', text: 'Checked an edit to src/a.ts: nothing found' }],
        }} />);
        expect(out).toContain('3 problems fixed · 1 edit blocked · 15 risky functions reviewed (12 fine) · 26 edits checked clean');
        expect(out).toContain('<code class="st-mono st-inline-code">api</code>');
        expect(out).toContain('Show 1 routine item');
        expect(out).not.toContain('nothing found');
    });

    it('shows a lesson journey, a dash where repeats do not apply, and "not recorded here" where unknown', () => {
        const base = { id: 'l', text: 'Fixtures use `sk_test_` keys', learnedFrom: 'A fix while an agent was writing', state: 'validated', scope: 'team', told: 3, canDecide: false };
        const dev = html(<LessonCard lesson={{ ...base, origin: 'development', stoppedInDevelopment: 2, reachedPr: null }} onDecide={() => undefined} />);
        expect(dev).toContain('3 times');
        expect(dev).toContain('2 times');
        expect(dev).toContain('not recorded here');
        expect(dev).toContain('shared with team');
        const memory = html(<LessonCard lesson={{ ...base, origin: 'memory', stoppedInDevelopment: null, reachedPr: null, canDecide: true }} onDecide={() => undefined} />);
        expect(memory).toContain('—');
        expect(memory).toContain('st-btn primary');
    });

    it('draws a trend with an explanation instead of bars when nothing is known', () => {
        const weeks = [{ from: '2026-10-02T00:00:00Z', stopped: 2, overruled: 0, repeatsStopped: 0, repeatsReachedPr: null, minutesToFix: 4, lessons: 1 }];
        expect(html(<Trend title="Reached a PR" hint="" weeks={weeks} value={w => w.repeatsReachedPr} empty="Shows once branch reviews run here." />)).toContain('Shows once branch reviews run here.');
        expect(html(<Trend title="Stopped" hint="" weeks={weeks} value={w => w.stopped} />)).toContain('>2<');
    });

    it('leaves quiet weeks out of the context table', () => {
        const quiet = { from: '2026-09-25T00:00:00Z', scopes: 0, filesReturned: 0, filesConsidered: 0, recalls: 0, lessonsTold: 0, reuse: 0 };
        expect(html(<WeeklyTable weeks={[quiet]} />)).toContain('No context requests in the last 8 weeks.');
        const busy = html(<WeeklyTable weeks={[quiet, { ...quiet, from: '2026-10-02T00:00:00Z', scopes: 2, filesReturned: 9, filesConsidered: 300 }]} />);
        expect(busy).toContain('9 of 300');
        expect(busy.match(/<tr>/g)).toHaveLength(2); // header and the one active week
    });

    it('opens a story to its code change, and hides the code block when there is none', () => {
        const story = { id: 's', at: '2026-10-02T10:00:00Z', stage: 'review' as const, file: 'a.ts', rule: 'review', title: 'Sent the key with redirects followed', details: 'Now redirect: "error".', diff: [] };
        const open = html(<StoryCard story={story} open onToggle={() => undefined} />);
        expect(open).toContain('What the agent fixed');
        expect(open).not.toContain('st-code');
        expect(html(<StoryCard story={{ ...story, rule: 'security-patterns', stage: 'edit', diff: ['-a', '+b'] }} open onToggle={() => undefined} />)).toContain('st-ln del');
    });

    it('formats counts and inline code', () => {
        expect([plural(1, 'problem'), plural(2, 'problem')]).toEqual(['1 problem', '2 problems']);
        expect(html(<p>{inlineCode('use `x` here')}</p>)).toBe('<p>use <code class="st-mono st-inline-code">x</code> here</p>');
    });
});
