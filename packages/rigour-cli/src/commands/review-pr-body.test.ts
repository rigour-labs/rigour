import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPrBody } from './review.js';

let dir: string | undefined;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('readPrBody', () => {
    it('prefers --pr-body, else reads the pull request of a GitHub Actions event, else nothing', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-'));
        fs.writeFileSync(path.join(dir, 'body.md'), 'Fix the redirect loop.');
        fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ pull_request: { title: 'fix: encode spaces', body: 'Paths with spaces looped.' } }));
        const event = { GITHUB_EVENT_PATH: path.join(dir, 'event.json') };
        expect(readPrBody(dir, { prBody: 'body.md' }, event)).toBe('Fix the redirect loop.');
        expect(readPrBody(dir, {}, event)).toBe('fix: encode spaces\n\nPaths with spaces looped.');
        expect(readPrBody(dir, {}, {})).toBeUndefined();
    });
});
