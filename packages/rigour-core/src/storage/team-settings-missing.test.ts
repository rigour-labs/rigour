import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-settings-'));
const NAMES = ['RIGOUR_TEAM_DATABASE_URL', 'RIGOUR_TEAM_DATABASE_URL_COMMAND', 'RIGOUR_ORGANIZATION_ID', 'RIGOUR_TEAM_ID', 'RIGOUR_ACTOR_ID'];

describe('team doctor without all team settings', () => {
    beforeAll(() => {
        vi.stubEnv('RIGOUR_HOME', home); // team.json would live here: there is none
        for (const name of NAMES) vi.stubEnv(name, '');
    });
    afterEach(() => { for (const name of NAMES) vi.stubEnv(name, ''); });
    afterAll(() => {
        vi.unstubAllEnvs();
        fs.rmSync(home, { recursive: true, force: true });
    });

    it('names what is missing when some settings are given', async () => {
        const { doctorTeamConnection } = await import('./team-store.js');
        vi.stubEnv('RIGOUR_TEAM_DATABASE_URL', 'postgresql://reviewer@db.example.com/rigour?sslmode=require');
        vi.stubEnv('RIGOUR_ORGANIZATION_ID', 'example-org');
        vi.stubEnv('RIGOUR_ACTOR_ID', 'review-bot');
        expect((await doctorTeamConnection()).message).toBe('Team mode is not configured: RIGOUR_TEAM_ID is missing (set it in the environment, or run rigour team configure).');
        vi.stubEnv('RIGOUR_ACTOR_ID', '');
        expect((await doctorTeamConnection()).message).toContain('RIGOUR_TEAM_ID, RIGOUR_ACTOR_ID are missing (set them');
    });

    it('says only that team mode is off when no setting is given', async () => {
        const { doctorTeamConnection } = await import('./team-store.js');
        expect((await doctorTeamConnection()).message).toBe('Team mode is not configured.');
    });
});
