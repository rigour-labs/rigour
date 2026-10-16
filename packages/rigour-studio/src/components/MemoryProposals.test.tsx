import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Journey } from './LearningParts';
import { LessonList } from './MemoryProposals';
import { TeamCard } from './GovernanceSide';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const proposal = (id: string, value: string, over: Partial<Journey> = {}): Journey => ({
    id, text: `retries: ${value}`, origin: 'memory', learnedFrom: 'Told by a person or an agent', learnedAt: '2026-10-10T00:00:00Z',
    state: 'candidate', scope: 'team', told: 0, stoppedInDevelopment: null, reachedPr: null, canDecide: true,
    memory: { key: 'retries', value }, ...over,
});

describe("team memory proposals for one key", () => {
    const cloud = proposal('l-cloud', 'Use withRetry.', { proposedBy: 'cloud-agent' });
    const laptop = proposal('l-laptop', 'Use withRetry.', { proposedBy: 'dev-a', yours: true, learnedAt: '2026-10-11T00:00:00Z' });
    const other = proposal('l-other', 'Three attempts, then fail.', { proposedBy: 'dev-b', canDecide: false });
    const fix: Journey = { ...proposal('l-fix', 'x'), text: 'Close the handle', origin: 'development', scope: 'personal', memory: undefined };

    it('groups proposals for the same key where the first stands, and leaves other lessons alone', () => {
        const out = html(<LessonList lessons={[fix, cloud, laptop, other]} onDecide={() => undefined} />);
        expect(out.indexOf('Close the handle')).toBeLessThan(out.indexOf('3 proposals'));
        expect(out.match(/st-card mem-lesson/g)).toHaveLength(2);
        expect(html(<LessonList lessons={[cloud, fix]} onDecide={() => undefined} />).match(/st-card mem-lesson/g)).toHaveLength(2);
    });

    it('shows one card per key: each value, who proposed it and when, Share and Drop each, and identical values said so', () => {
        const out = html(<LessonList lessons={[cloud, laptop, other]} onDecide={() => undefined} />);
        expect(out.match(/3 proposals/g)).toHaveLength(1);
        expect(out).toContain('Proposed by cloud-agent on 2026-10-10. Same value as you.');
        expect(out).toContain('Proposed by you on 2026-10-11. Same value as cloud-agent.');
        expect(out).toContain('Proposed by dev-b on 2026-10-10. </div>');
        expect(out).toContain('Three attempts, then fail.');
        expect(out.match(/Share with team/g)).toHaveLength(2);
        expect(out.match(/>Drop</g)).toHaveLength(2);
        expect(out).toContain('An sme or owner decides on a teammate&#x27;s proposal.');
        expect(out).toContain('Sharing one leaves the others as they are');
    });

    it('shows the shared version beside a proposal for its key, with Take back, and says sharing replaces it', () => {
        const shared = proposal('l-shared', 'Retry twice.', { state: 'promoted', canDecide: false, canRetire: true });
        const out = html(<LessonList lessons={[cloud, shared]} onDecide={() => undefined} onTakeBack={() => undefined} />);
        expect(out.match(/st-card mem-lesson/g)).toHaveLength(1);
        expect(out).toContain('Shared now');
        expect(out).toContain('Retry twice.');
        expect(out).toContain('1 proposal');
        expect(out).toContain('Sharing this replaces the shared version.');
        expect(out.match(/>Take back</g)).toHaveLength(1);
    });

    it('offers Take back on a shared team memory of its own, only where the person may take it back', () => {
        const shared = proposal('l-shared', 'Retry twice.', { state: 'promoted', canDecide: false });
        expect(html(<LessonList lessons={[{ ...shared, canRetire: true }]} onDecide={() => undefined} />)).toContain('>Take back<');
        expect(html(<LessonList lessons={[shared]} onDecide={() => undefined} />)).not.toContain('>Take back<');
    });

    it("names a teammate's single candidate on its own card", () => {
        expect(html(<LessonList lessons={[cloud]} onDecide={() => undefined} />)).toContain('Proposed by cloud-agent');
        expect(html(<LessonList lessons={[laptop]} onDecide={() => undefined} />)).not.toContain('Proposed by');
    });
});

describe('the team card', () => {
    const team = { sync: true, organization: 'acme', team: 'web', actor: 'dev-a', sharing: null, received: 0 };
    it("says what this person sees of teammates' candidates when the last sync said, the general line otherwise", () => {
        expect(html(<TeamCard team={{ ...team, candidates: 'As an sme or owner, you see every member\'s team candidates.' }} />)).toContain('As an sme or owner');
        expect(html(<TeamCard team={team} />)).toContain('Teammates&#x27; candidates are visible only to them until shared.');
    });

    it('counts the changes the team database refused, with the latest reason', () => {
        const out = html(<TeamCard team={{ ...team, refused: { count: 2, latest: 'refused by the team database: new row violates row-level security policy' } }} />);
        expect(out).toContain('Refused by the team database, 28 days');
        expect(out).toContain('The latest: refused by the team database: new row violates row-level security policy');
        expect(html(<TeamCard team={team} />)).not.toContain('Refused by the team database');
    });
});
