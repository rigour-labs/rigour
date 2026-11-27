import { describe, expect, it } from 'vitest';
import { ownerState, thisProcess } from './owner-process.js';
import { ON_POSIX, POSIX_ONLY } from './__tests__/run-code-harness.js';

describe.runIf(ON_POSIX)(`a process's start time ${POSIX_ONLY}`, () => {
    it('reads the same in every locale and time zone, so another review never takes a live owner for gone', () => {
        const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
        const read = (env: Record<string, string>) => {
            Object.assign(process.env, env);
            return thisProcess();
        };
        try {
            const here = read({ LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', TZ: 'Asia/Tokyo' });
            const there = read({ LC_ALL: 'C', LANG: 'C', TZ: 'America/Los_Angeles' });
            expect(here.started).toBeTruthy();
            expect(there).toEqual(here);
            expect(ownerState(here)).toBe('alive');
        } finally {
            for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
        }
    });
});
