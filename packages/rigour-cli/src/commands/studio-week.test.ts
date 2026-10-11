import { describe, expect, it } from 'vitest';
import type { Story } from '@rigour-labs/core';
import { buildWeek } from './studio-week.js';
import { reviewFixStory } from './studio-checkouts.js';

const now = new Date('2026-10-09T12:00:00Z');
const story = (at: string, stage: Story['stage']): Story => ({ id: at, at, stage, file: 'src/a.ts', rule: 'semantic-bugs', title: 'T', diff: [] });

describe('buildWeek', () => {
    it('counts only this week, by the stage that caught it, and says how far the record goes back', () => {
        const week = buildWeek({
            now,
            stories: [story('2026-09-20T00:00:00Z', 'edit'), story('2026-10-05T00:00:00Z', 'edit'), story('2026-10-06T00:00:00Z', 'stop'), story('2026-10-07T00:00:00Z', 'review')],
            open: [{ file: 'src/b.ts', rule: 'semantic-bugs', title: 'Open one', openedAt: '2026-10-08T00:00:00Z' }],
            dismissals: [{ key: 'k', reason: 'intended', at: '2026-10-08T00:00:00Z' }, { key: 'old', reason: 'x', at: '2026-09-01T00:00:00Z' }],
            events: [],
        });
        expect(week.recordingSince).toBe('2026-09-20T00:00:00Z');
        // Three fixed, and one still open (caught at the edit): every problem held this week, each once.
        expect(week.stopped).toEqual({ total: 4, fixed: 3, byStage: { edit: 2, review: 1, stop: 1, pr: 0 } });
        expect(week.agentSaidDone).toBe(1);
        expect(week.stories.map(s => s.at)).toEqual(['2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z', '2026-10-05T00:00:00Z']);
        expect([week.raised, week.overruled]).toEqual([5, 1]);
        expect(week.needs).toEqual([expect.objectContaining({ title: 'Open one' })]);
    });

    it('reports PR catches as unknown, not zero, when no branch review was ever recorded here', () => {
        expect(buildWeek({ now, stories: [], open: [], dismissals: [], events: [] }).prCatches).toBeNull();
        const events = [{ type: 'pr_catches', timestamp: '2026-10-08T00:00:00Z', findings: [{ rule: 'r', title: 't', file: 'f' }] }];
        expect(buildWeek({ now, stories: [], open: [], dismissals: [], events }).prCatches).toBe(1);
    });

    it('counts a function an agent fixed in a pre-PR review as a problem stopped', () => {
        const fix = reviewFixStory({ file: 'src/insights.ts', function: 'loadDiagnosis', hash: 'h', reviewer: 'agent', verdict: 'fixed', note: 'Six positional parameters replaced by one options object.', at: '2026-10-08T00:00:00Z' });
        expect(fix).toMatchObject({ stage: 'review', title: 'Six positional parameters replaced by one options object (in `loadDiagnosis`)', diff: [] });
        expect(buildWeek({ now, stories: [fix], open: [], dismissals: [], events: [] }).stopped.byStage.review).toBe(1);
    });
});
