import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionCard } from './Activity';
import { WeeklyTable } from './AgentContext';
import { LearnsLead, LessonCard, OutcomeCard } from './LearningParts';
import { ProjectIdentity } from './ProjectIdentity';
import { Trend } from './Progress';
import { ReadOnlyNote } from './ReadOnlyNote';
import { inlineCode, plural } from './storyData';
import { StoryCard } from './Week';
import { groupNeeds, NeedGroupCard, needsHeading } from './NeedGroups';
import { Agents, Settings, Verdict } from './ReviewerParts';
import { SwitchSettings, type SwitchData } from './SwitchParts';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Studio pages', () => {
    it('summarises a session and lists only what mattered until asked', () => {
        const out = html(<SessionCard session={{
            start: '2026-10-02T08:16:00Z', end: '2026-10-02T10:32:00Z',
            counts: { stopped: 1, reported: 0, fixed: 0, checked: 26, reviewed: 15, taught: 0, pr: 0, reviewedFixed: 3 },
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

describe('the numbers after the merge, on the learning page', () => {
    it('shows counts, a percentage only where there is one, and the two groups side by side without comparing them', () => {
        const few = { count: 1, of: 4, rate: null };
        const out = html(<OutcomeCard numbers={{ records: { merged: 12, settled: 11, unsettled: 1 }, settled: { ciRegressed: { count: 2, of: 11, rate: 0.18 }, ciUnknown: 0, reverted: { count: 0, of: 11, rate: 0 }, fixedLater: { count: 3, of: 11, rate: 0.27 }, reviewed: { prs: 4, fixedLater: few }, notReviewed: { prs: 7, fixedLater: { count: 2, of: 7, rate: null } } }, lessons: { awaitingDecision: 2, promotedFromEvidence: 1, dismissed: 0, takenBack: 1 } }} />);
        expect(out).toContain('2 of 11 (18%)');
        expect(out).toContain('4 pull requests, 1 fixed later');
        expect(out).toContain('7 pull requests, 2 fixed later');
        expect(out).toContain('this is not a comparison');
        expect(out).not.toMatch(/fewer fixes|better|worse/);
    });

    it('shows the model reviewer\'s share and cost: counts, a percentage and a median only from ten, and what was left out', () => {
        const base = { records: { merged: 1, settled: 1, unsettled: 0 }, settled: { ciRegressed: { count: 0, of: 1, rate: null }, ciUnknown: 0, reverted: { count: 0, of: 1, rate: null }, fixedLater: { count: 0, of: 1, rate: null }, reviewed: { prs: 1, fixedLater: { count: 0, of: 1, rate: null } }, notReviewed: { prs: 0, fixedLater: { count: 0, of: 0, rate: null } } }, lessons: { awaitingDecision: 0, promotedFromEvidence: 0, dismissed: 0, takenBack: 0 } };
        const few = html(<OutcomeCard numbers={{ ...base, model: { share: { model: 2, checks: 3, prs: 4, rate: null }, costPerPr: { prs: 4, totalUsd: 3.5, medianUsd: null, prsEarlierBasis: 2 } } }} />);
        expect(few).toContain('2 of 5 findings at first review on 4 pull requests, the rest');
        expect(few).toContain('$3.50 over 4 pull requests.');
        expect(few).toContain('2 more reviewed before every run was counted, left out.');
        expect(few).not.toContain('%');
        const many = html(<OutcomeCard numbers={{ ...base, model: { share: { model: 3, checks: 10, prs: 10, rate: 0.23 }, costPerPr: { prs: 10, totalUsd: 55, medianUsd: 5.5, prsEarlierBasis: 0 } } }} />);
        expect(many).toContain('(23%)');
        expect(many).toContain('$5.50 each at the median');
        expect(html(<OutcomeCard numbers={base} />)).not.toContain('The model reviewer');
    });
});

describe('a lesson back to a candidate, on the learning page', () => {
    it('says why, shows the old evidence and offers Promote and Dismiss', () => {
        const out = html(<LessonCard lesson={{ id: 'd1d2c3d4e5f6', text: 'guard a missing items list', origin: 'pr', learnedFrom: 'At PR #7, from r', state: 'candidate', scope: 'this repo', told: 0, stoppedInDevelopment: null, reachedPr: null, canDecide: true, reclassified: { detail: 'promoted by the exact-line rule, which no longer promotes on its own', evidence: ['fixed later by abc123def "fix: total crashes"'] } } as any} onDecide={() => undefined} onDecideReview={() => undefined} />);
        expect(out).toContain('back to candidate</span> <span class="st-sub">promoted by the exact-line rule');
        expect(out).toContain('fixed later by abc123def');
        expect(out).toContain('>Promote<');
        expect(out).toContain('>Dismiss<');
        expect(out).not.toContain('Seen once');
    });
});

describe('a candidate with a later fix on its lines, on the learning page', () => {
    it('shows the fix and offers Promote and Dismiss', () => {
        const out = html(<LessonCard lesson={{ id: 'b1b2c3d4e5f6', text: 'keep the composer scrollable', origin: 'pr', learnedFrom: 'At PR #4, from r1', state: 'candidate', scope: 'this repo', told: 0, stoppedInDevelopment: null, reachedPr: null, canDecide: true, suggested: { detail: 'fixed later by abc123def "fix: composer overflow"', pr: 4, at: '2026-09-05T00:00:00Z' } } as any} onDecide={() => undefined} onDecideReview={() => undefined} />);
        expect(out).toContain('a later fix changed these lines');
        expect(out).toContain('The pull request (#4) left this point alone');
        expect(out).toContain('>Promote<');
        expect(out).toContain('>Dismiss<');
        expect(out).not.toContain('Seen once');
    });
});

describe('a lesson taken back on the learning page', () => {
    it('says why and offers to promote it again', () => {
        const out = html(<LessonCard lesson={{ id: 'a1b2c3d4e5f6', text: 'take the lock first', origin: 'pr', learnedFrom: 'At PR #1, from r1', state: 'candidate', scope: 'this repo', told: 0, stoppedInDevelopment: null, reachedPr: null, canDecide: true, takenBack: { detail: 'taken back: #50, #51 repeated it and settled clean', prs: [50, 51], at: '2026-10-01T00:00:00Z' } } as any} onDecide={() => undefined} onDecideReview={() => undefined} />);
        expect(out).toContain('taken back</span> <span class="st-sub">taken back: #50, #51 repeated it and settled clean');
        expect(out).toContain('Promote again');
        expect(out).not.toContain('Seen once');
    });
});

describe('the goal check on the Setup page', () => {
    const text = { title: 'The goal check', lead: 'Checks a change against its goal.', row: 'Check the goal', rowHelp: 'Required: no one may turn it off.', name: 'goal check' };
    const goal = (over: Partial<SwitchData>): SwitchData => ({ effective: { enabled: false, source: 'team', required: false, refused: [] }, team: 'off', teamFile: false, user: null, ...over });
    const draw = (data: SwitchData, canWrite = true, diff: string | null = null) => html(<SwitchSettings text={text} data={data} canWrite={canWrite} saving={false} problem={null} diff={diff} onSave={() => undefined} />);

    it('shows what runs and where it comes from, your choice and the team\'s', () => {
        const out = draw(goal({ effective: { enabled: true, source: 'user', required: false, refused: [] }, user: true }));
        expect(out).toContain('The goal check');
        expect(out).toContain('<span class="st-mono">on</span> <span class="st-sub">· yours</span>');
        expect(out).toContain('aria-label="Your goal check"');
        expect(out).toContain('aria-label="Team goal check"');
        expect(out).toContain('setting the team&#x27;s value creates one');
    });

    it('locks under the team\'s floor and lists what was not applied, with the diff to commit', () => {
        const out = draw(goal({ effective: { enabled: true, source: 'team', required: true, refused: ['goal check off (user) refused: rigour.yml sets review.goal: required'] }, team: 'required', teamFile: true, user: false }), true, '+  goal: required');
        expect(out).toContain('aria-label="your team requires the goal check"');
        expect(out).toContain('not applied</span> goal check off (user) refused');
        expect(out).toContain('rigour.yml changed');
        expect(out).not.toContain('creates one');
    });

    it('is read-only without the Studio key', () => {
        const out = draw(goal({}), false);
        expect(out).toContain('Open Studio from the link the terminal printed');
        expect(out.match(/disabled=""/g)?.length).toBe(6); // yours: Team, on, off; the team's: off, on, required
    });
});

function reviewerData(over: Record<string, unknown>): any {
    return {
        branch: 'feature', status: null, teamFile: false, user: {}, team: { enabled: false, mode: 'single', panel: 'off', judges: 2, escalate: 'always' }, available: [],
        effective: { enabled: false, mode: 'single', panel: false, judges: 2, escalate: 'always', dismissals: false, reviewers: ['claude'], source: { mode: 'team', panel: 'team' }, required: { mode: false, panel: false }, refused: [] },
        ...over,
    };
}

describe('the browser tab', () => {
    it('is titled Rigour Studio, and nothing else', () => {
        const page = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
        expect(/<title>([^<]*)<\/title>/.exec(page)?.[1]).toBe('Rigour Studio');
    });
});


describe('the header', () => {
    it('names the repository and its branch, never a path or a package version', () => {
        const html = renderToStaticMarkup(<ProjectIdentity name="payments" branch="main" />);
        expect(html).toContain('>payments<');
        expect(html).toContain('>main<');
        expect(html).not.toMatch(/\/Users\/|\/home\/|v\d+\.\d+/);
    });
});

describe('open findings on the home page', () => {
    const need = (file: string, title: string, openedAt: string, rule = 'hallucinated-imports') => ({ file, rule, title, openedAt });
    const needs = [
        need('src/a.ts', "Import 'left-pad' not found", '2026-10-01T00:00:00Z'),
        need('src/b.ts', "Import 'lodash/fp' not found", '2026-10-03T00:00:00Z'),
        need('src/a.ts', "Import 'zod' not found", '2026-10-02T00:00:00Z'),
        need('src/c.ts', 'Function is 120 lines long', '2026-10-04T00:00:00Z', 'file-size'),
    ];

    it('group by check and message pattern, newest first', () => {
        const groups = groupNeeds(needs);
        expect(groups.map(g => [g.rule, g.pattern, g.needs.length, g.files])).toEqual([
            ['file-size', 'Function is N lines long', 1, 1],
            ['hallucinated-imports', 'Import … not found', 3, 2],
        ]);
        expect(groups[1].needs.map(n => n.file)).toEqual(['src/b.ts', 'src/a.ts', 'src/a.ts']);
    });

    it('show a repeated problem once, as a count in its files, closed until opened', () => {
        const html = renderToStaticMarkup(<NeedGroupCard group={groupNeeds(needs)[1]} onDone={() => {}} />);
        expect(html).toContain('3 × Import … not found, in 2 files');
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain('left-pad');
    });

    it('are counted in the heading as findings, with their kinds when a kind repeats', () => {
        const many = Array.from({ length: 61 }, (_, i) => need(`src/f${i % 7}.ts`, `Problem of kind ${i % 5 === 0 ? "'a'" : i % 5}`, '2026-10-01T00:00:00Z', `check-${i % 5}`));
        expect(needsHeading(groupNeeds(many))).toBe('61 findings need you, of 5 kinds.');
        expect(needsHeading(groupNeeds(needs.slice(0, 2)))).toBe('2 findings need you, of 1 kind.');
        expect(needsHeading(groupNeeds([needs[0], needs[3]]))).toBe('2 findings need you.');
        expect(needsHeading(groupNeeds([needs[3]]))).toBe('1 finding needs you.');
        expect(needsHeading([])).toBe('Nothing needs you.');
    });

    it('show a single finding as its own card', () => {
        const html = renderToStaticMarkup(<NeedGroupCard group={groupNeeds(needs)[0]} onDone={() => {}} />);
        expect(html).toContain('Function is 120 lines long');
        expect(html).toContain('Copy for my agent');
    });
});

describe('a read-only tab', () => {
    it('says in one line that the printed link gives edit rights, and can be hidden', () => {
        const html = renderToStaticMarkup(<ReadOnlyNote />);
        expect(html).toContain('Read-only. Open the link <code>rigour studio</code> printed in your terminal: it gives this tab edit rights.');
        expect(html).toContain('aria-label="Hide this note"');
        expect(html).not.toContain('<p>');
    });
});

describe('how lessons reach an agent, on the learning page', () => {
    it('says agents get them on request, and in Claude Code by itself only with the brief hooks', () => {
        const html = renderToStaticMarkup(<LearnsLead />).replace(/\s+/g, ' ');
        expect(html).toContain('An agent gets the lessons when it asks for a brief (the <code>rigour_brief</code> tool, or <code>rigour brief</code>).');
        expect(html).toContain('In Claude Code, <code>rigour hooks init --brief</code> hands them over by itself');
        expect(html).not.toMatch(/told before they write/);
    });
});

describe('an edit check that ran without --block, on the activity page', () => {
    it('reads as reported, never as blocked', () => {
        const out = renderToStaticMarkup(<SessionCard session={{
            start: '2026-10-02T08:16:00Z', end: '2026-10-02T08:16:00Z',
            counts: { stopped: 0, reported: 2, fixed: 0, checked: 0, reviewed: 0, taught: 0, pr: 0, reviewedFixed: 0 },
            highlights: [{ at: '2026-10-02T08:16:00Z', kind: 'reported', text: 'Reported on an edit to src/a.ts: Import not found' }],
            rest: [],
        }} />);
        expect(out).toContain('2 edits reported on');
        expect(out).toContain('>reported<');
        expect(out).not.toMatch(/blocked|Stopped/);
    });
});
