import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../types/index.js';
import { resolveReviewer } from './settings.js';

const team = (reviewer: Record<string, unknown> = {}) => ConfigSchema.parse({ version: 1, review: { reviewer } });

describe('the reviewer settings a run uses', () => {
    it('is one judge, no panel, until someone asks', () => {
        expect(resolveReviewer(team(), {}, undefined, {})).toMatchObject({ enabled: false, mode: 'single', panel: false, judges: 2, escalate: 'always', source: { mode: 'team', panel: 'team' }, refused: [] });
    });

    it('takes the nearest layer: a flag, then the environment, then the person, then the team', () => {
        const user = { enabled: true, mode: 'full' as const, panel: true, judges: 3 as const };
        expect(resolveReviewer(team({ mode: 'single' }), {}, user, {})).toMatchObject({ enabled: true, mode: 'full', panel: true, judges: 3, source: { mode: 'user', panel: 'user' } });
        expect(resolveReviewer(team(), {}, user, { RIGOUR_REVIEWER_PANEL: 'off', RIGOUR_REVIEWER_MODE: 'cross' })).toMatchObject({ mode: 'cross', panel: false, source: { mode: 'env', panel: 'env' } });
        expect(resolveReviewer(team(), { mode: 'single', panel: false }, user, { RIGOUR_REVIEWER_MODE: 'full' })).toMatchObject({ mode: 'single', source: { mode: 'flag' } });
    });

    it('turns a panel into a full review, since it needs two vendors', () => {
        expect(resolveReviewer(team({ mode: 'single' }), { panel: true }, undefined, {})).toMatchObject({ mode: 'full', panel: true, source: { mode: 'flag', panel: 'flag' } });
    });

    it('keeps the team floor, and says what it refused', () => {
        const floor = team({ mode: 'full', panel: 'required', mode_required: true });
        const resolved = resolveReviewer(floor, { mode: 'single', panel: false }, { escalate: 'risk' }, {});
        expect(resolved).toMatchObject({ mode: 'full', panel: true, escalate: 'always', required: { mode: true, panel: true } });
        expect(resolved.refused).toEqual([
            'panel off (flag) refused: rigour.yml sets review.reviewer.panel: required',
            'mode single (flag) refused: rigour.yml sets review.reviewer.mode_required with mode full',
            'escalate risk (user) refused: rigour.yml requires every review to be full',
        ]);
    });

    it('reports an environment value it does not understand instead of ignoring it quietly', () => {
        expect(resolveReviewer(team(), {}, undefined, { RIGOUR_REVIEWER_MODE: 'triple', RIGOUR_REVIEWER_PANEL: 'maybe' }).refused).toEqual([
            'RIGOUR_REVIEWER_MODE=triple ignored: use single, cross or full',
            'RIGOUR_REVIEWER_PANEL=maybe ignored: use on or off',
        ]);
    });

    it('lets a nearer choice of one judge turn a panel off, unless the team requires it, and says when it refuses', () => {
        expect(resolveReviewer(team({ mode: 'full', panel: 'on' }), { mode: 'single' }, undefined, {})).toMatchObject({ mode: 'single', panel: false, refused: [] });
        expect(resolveReviewer(team(), { mode: 'single' }, { panel: true }, {})).toMatchObject({ mode: 'single', panel: false }); // the flag is nearer than your setting
        const user = resolveReviewer(team(), {}, { mode: 'single', panel: true }, {});
        expect(user).toMatchObject({ mode: 'full', panel: true });
        expect(user.refused).toEqual(['mode single (user) refused: the panel (user) needs judges from two vendors']);
        expect(resolveReviewer(team({ mode: 'full', panel: 'required' }), { mode: 'single' }, undefined, {}).refused).toEqual(['mode single (flag) refused: rigour.yml sets review.reviewer.panel: required']);
    });

    it('under a team floor a person cannot turn reviews off or lower the judges', () => {
        const floor = team({ enabled: true, mode: 'full', judges: 3, mode_required: true });
        const resolved = resolveReviewer(floor, {}, { enabled: false, judges: 2 }, {});
        expect(resolved).toMatchObject({ enabled: true, judges: 3 });
        expect(resolved.refused).toEqual(['reviews off (user) refused: rigour.yml requires the reviewer', 'judges 2 (user) refused: rigour.yml requires 3']);
        expect(resolveReviewer(team({ enabled: true }), {}, { enabled: false, judges: 3 }, {})).toMatchObject({ enabled: false, judges: 3 }); // no floor: your choice
    });
});

