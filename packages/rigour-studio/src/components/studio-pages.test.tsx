import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionCard } from './Activity';
import { WeeklyTable } from './AgentContext';
import { LessonCard } from './Learning';
import { Trend } from './Progress';
import { inlineCode, plural } from './storyData';
import { StoryCard } from './Week';
import { Agents, Settings, Verdict } from './ReviewerParts';

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

    it('shows the reviewer\'s verdict, what ran against what was asked, and only confirmed findings as work', () => {
        const data = reviewerData({ status: { last: { head: 'abcdef0123456', at: '2026-10-06T10:00:00Z', mode: 'full', ran: { asked: 'panel', ran: 'single', source: 'user', degraded: '3 judges asked, claude could run (not installed: codex, cursor-agent)' },
            open: [{ id: 'abcdef0123', kind: 'finding', class: 'correctness', file: 'src/job.ts', line: 2, issue: 'returns before the lock', consequence: 'two runs send the same email', reviewer: 'claude+codex' }],
            disputed: [{ id: 'ffff000011', kind: 'finding', class: 'production-cost', file: 'src/job.ts', line: 9, issue: 'maybe slow' }] } } });
        const out = html(<Verdict data={{ ...data, effective: { ...data.effective, dismissals: true } }} canWrite onChange={() => undefined} />);
        expect(html(<Verdict data={data} canWrite onChange={() => undefined} />)).not.toContain('Not a bug'); // the team has not allowed dismissals
        expect(out).toContain('1 finding to fix');
        expect(out).toContain('Asked for a panel: only what a majority confirms blocks (user); ran one judge. 3 judges asked, claude could run (not installed: codex, cursor-agent)');
        expect(out).toContain('one judge, the whole branch at abcdef012');
        expect(out).toContain('found by claude and codex');
        expect(out).toContain('What goes wrong: two runs send the same email');
        expect(out).toContain('No majority, so these never block:');
        expect(out.match(/Not a bug/g)).toHaveLength(1); // a disputed finding is not work, so there is nothing to dismiss
        expect(html(<Verdict data={reviewerData({})} canWrite={false} onChange={() => undefined} />)).toContain('No verdict yet.');
        const stuck = html(<Verdict data={reviewerData({ status: { attempt: { head: 'abcdef0123456', outcome: 'unavailable', reason: 'rigour.yml requires two reviewers from different vendors', at: '2026-10-06T10:00:00Z' } } })} canWrite={false} onChange={() => undefined} />);
        expect(stuck).toContain('could not run');
        expect(stuck).toContain('rigour.yml requires two reviewers from different vendors');
        expect(stuck).not.toContain('No verdict yet');
    });

    it('shows every setting as what runs, yours and the team\'s, locks a team floor, and is read-only without the launch key', () => {
        const locked = reviewerData({ effective: { ...reviewerData({}).effective, panel: true, mode: 'full', required: { mode: false, panel: true }, refused: ['panel off (user) refused: rigour.yml sets review.reviewer.panel: required'] }, team: { panel: 'required', mode: 'full' }, teamFile: true, user: { panel: false } });
        const out = html(<Settings data={locked} canWrite saving={null} onSave={() => undefined} onSaveTeam={() => undefined} />);
        expect(out).toContain('aria-label="your team requires the panel"');
        expect(out).toContain('in <span class="st-mono">rigour.yml</span>: a change here edits the file, and you commit it');
        expect(out).toContain('role="radiogroup" aria-label="Team Panel"');
        expect(out).toMatch(/aria-label="Team Panel"[^]*?aria-checked="true" class="on"[^>]*>required</);
        expect(out).toContain('not applied');
        const readOnly = html(<Settings data={reviewerData({})} canWrite={false} saving={null} onSave={() => undefined} onSaveTeam={() => undefined} />);
        expect(readOnly).toContain('Open Studio from the link the terminal printed');
        expect(readOnly).not.toContain('Set team defaults');
        expect(readOnly).toContain('disabled=""');
        expect(out).toContain('role="radiogroup" aria-label="Your Panel"');
        expect(out).toContain('aria-label="Team Judges"');
        expect(out).toMatch(/role="radio" aria-checked="true" class="on"[^>]*>off</); // the person's own choice, not the team's
    });

    it('marks the team\'s choice when a person has not chosen', () => {
        const out = html(<Settings data={reviewerData({})} canWrite saving={null} onSave={() => undefined} onSaveTeam={() => undefined} />);
        expect(out.match(/aria-checked="true" class="on"[^>]*>Team</g)).toHaveLength(5); // every setting a person can choose
        expect(out).toContain('aria-label="Team Dismissals"'); // a team decision only
        expect(out).toContain('Set team defaults'); // no rigour.yml: creating one is an explicit step
    });

    it('shows today\'s spend against the daily caps', () => {
        const capped = reviewerData({ status: { today: { runs: 7, usd: 2.1 } }, effective: { ...reviewerData({}).effective, max_runs_per_day: 20, max_usd_per_day: 10 } });
        expect(html(<Settings data={capped} canWrite saving={null} onSave={() => undefined} onSaveTeam={() => undefined} />)).toContain('7 agent runs of 20 allowed, $2.10 reported of $10.00.');
        expect(html(<Settings data={reviewerData({})} canWrite saving={null} onSave={() => undefined} onSaveTeam={() => undefined} />)).toContain('No daily cap');
    });

    it('says how many judges this machine can field', () => {
        const two = reviewerData({ effective: { ...reviewerData({}).effective, reviewers: ['claude', 'codex', 'cursor'] }, available: [{ name: 'claude', vendor: 'anthropic', binary: 'claude', installed: true, version: '2.1' }, { name: 'codex', vendor: 'openai', binary: 'codex', installed: true }, { name: 'cursor', vendor: 'cursor', binary: 'cursor-agent', installed: false }] });
        const out = html(<Agents data={two} />);
        expect(out).toContain('Enough for two judges; a third vendor, listed in the reviewers, allows three.');
        expect(out).toContain('cursor-agent: not installed');
    });
});

function reviewerData(over: Record<string, unknown>): any {
    return {
        branch: 'feature', status: null, teamFile: false, user: {}, team: { enabled: false, mode: 'single', panel: 'off', judges: 2, escalate: 'always' }, available: [],
        effective: { enabled: false, mode: 'single', panel: false, judges: 2, escalate: 'always', dismissals: false, reviewers: ['claude'], source: { mode: 'team', panel: 'team' }, required: { mode: false, panel: false }, refused: [] },
        ...over,
    };
}
