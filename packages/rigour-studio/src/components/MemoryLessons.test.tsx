import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Journey } from './LearningParts';
import { LessonsTriage } from './MemoryLessons';
import { lessonState } from './lessonWords';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const lesson = (id: string, over: Partial<Journey> = {}): Journey => ({
    id, text: `deploy_${id}: Run the migrations before the web tier, then warm the cache.`, origin: 'memory', learnedFrom: 'Told by a person or an agent',
    learnedAt: '2026-10-10T00:00:00Z', state: 'candidate', scope: 'personal', told: 2, stoppedInDevelopment: null, reachedPr: null, canDecide: true, ...over,
});

describe('the Lessons tab as a triage list', () => {
    const waiting = Array.from({ length: 30 }, (_, i) => lesson(`w${i}`));
    const inForce = [lesson('f1', { state: 'validated', canDecide: false }), lesson('f2', { state: 'promoted', scope: 'team', canDecide: false })];
    const gone = [lesson('g1', { origin: 'pr', state: 'rejected', canDecide: false })];
    const all = [...waiting, ...inForce, ...gone];

    it('opens on what waits for a person, with a chip and count per pile, a search and pages of 25', () => {
        const out = html(<LessonsTriage lessons={all} onDecide={() => undefined} />);
        expect(out).toContain('aria-pressed="true" class="on">Waiting for a person<span class="ui-filterchip-count">30</span>');
        expect(out).toContain('In force<span class="ui-filterchip-count">2</span>');
        expect(out).toContain('Taken back or dropped<span class="ui-filterchip-count">1</span>');
        expect(out).toContain('All<span class="ui-filterchip-count">33</span>');
        expect(out).toContain('aria-label="Search lessons by key or text"');
        expect(out).toContain('1–25 of 30');
        expect(out.match(/ui-list-row mem-lesson/g)).toHaveLength(25);
    });

    it('lands on in force when nothing waits', () => {
        expect(html(<LessonsTriage lessons={inForce} onDecide={() => undefined} />)).toContain('aria-pressed="true" class="on">In force');
    });

    it('searches keys and text within the pile', () => {
        const one = html(<LessonsTriage lessons={all} onDecide={() => undefined} initialQuery="deploy_w12" />);
        expect(one).toContain('1 lesson<');
        expect(one.match(/ui-list-row mem-lesson/g)).toHaveLength(1);
        expect(html(<LessonsTriage lessons={all} onDecide={() => undefined} initialQuery="warm cache" />)).toContain('30 lessons<');
        expect(html(<LessonsTriage lessons={all} onDecide={() => undefined} initialQuery="nothing-like-it" />)).toContain('No lesson here matches');
    });

    it('gives each lesson one state chip in plain words, and no contradicting chips', () => {
        expect(lessonState(lesson('a', { scope: 'team' }))).toBe('waiting');
        expect(lessonState(inForce[0])).toBe('machine');
        expect(lessonState(inForce[1])).toBe('team');
        expect(lessonState(gone[0])).toBe('dropped');
        expect(lessonState(lesson('s', { state: 'superseded', canDecide: false }))).toBe('replaced');
        const candidate = html(<LessonsTriage lessons={[lesson('t', { scope: 'team', proposedBy: 'dev-a' })]} onDecide={() => undefined} />);
        expect(candidate).toContain('waiting for a person');
        expect(candidate).not.toContain('shared with the team');
        expect(candidate).not.toContain('>candidate<');
        expect(candidate).toContain('told to remember by dev-a');
        expect(candidate).not.toContain('Stopped in development');
    });
});

describe('why sharing waits', () => {
    it('is said once above the list when many candidates share the reason, and not on their rows', () => {
        const why = 'An sme or owner shares it with the team.';
        const team = Array.from({ length: 4 }, (_, i) => lesson(`n${i}`, { scope: 'team', noShare: why }));
        const out = html(<LessonsTriage lessons={team} onDecide={() => undefined} />);
        expect(out.match(/An sme or owner shares it with the team\./g)).toHaveLength(1);
        expect(out).toContain(`Share with team waits: ${why}`);
        expect(out).not.toContain('Share with team</button>');
        const two = html(<LessonsTriage lessons={team.slice(0, 2)} onDecide={() => undefined} />);
        expect(two.match(/An sme or owner shares it with the team\./g)).toHaveLength(2);
        expect(two).not.toContain('Share with team waits');
    });
});

describe('the decision hint on a lesson row', () => {
    it('sits on its own line above the buttons, never between them', () => {
        const review = lesson('r', { origin: 'pr', learnedFrom: 'At PR #7, from reviewer-a', text: 'Validate the response before rendering.' });
        const out = html(<LessonsTriage lessons={[review]} onDecide={() => undefined} />);
        expect(out).toMatch(/<div class="ui-meta mem-hint">From review, not confirmed yet\.[^<]*<\/div><div class="ui-list-foot">/);
        expect(out).toMatch(/<div class="ui-actions"><button[^>]*>Promote<\/button><button[^>]*>Not a rule<\/button><button[^>]*>Drop<\/button><\/div>/);
    });
});
