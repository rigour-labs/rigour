import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates } from './version.js';

describe('the update check', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('never asks the registry in CI, in an agent hook, or when the person opted out', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const review = ['node', 'rigour', 'review'];
        for (const env of [{ RIGOUR_UPDATE_CHECK: '0' }, { DO_NOT_TRACK: '1' }, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
            expect(await checkForUpdates('1.0.0', env, review)).toBeNull();
        }
        expect(await checkForUpdates('1.0.0', {}, ['node', 'rigour', 'hooks', 'check'])).toBeNull(); // an agent hook on every edit
        expect(fetch).not.toHaveBeenCalled();
    });

    it('asks once a day for a person at a terminal', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({ version: '9.0.0' })));
        vi.stubGlobal('fetch', fetch);
        expect(await checkForUpdates('1.0.0', {}, ['node', 'rigour', 'review'])).toMatchObject({ hasUpdate: true, latestVersion: '9.0.0' });
        expect(await checkForUpdates('1.0.0', {}, ['node', 'rigour', 'review'])).toMatchObject({ latestVersion: '9.0.0' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
