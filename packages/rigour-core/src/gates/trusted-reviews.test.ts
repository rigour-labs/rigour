import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustedReviews } from './deep-analysis.js';

let cwd: string;
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('trustedReviews', () => {
    it('lets a normal run skip what agents recorded as reviewed, and an independent run skip nothing', () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-reviews-'));
        fs.mkdirSync(path.join(cwd, '.rigour'));
        fs.writeFileSync(path.join(cwd, '.rigour', 'reviewed.json'), JSON.stringify({ version: 1, entries: [{ file: 'src/a.ts', function: 'f', hash: 'h', reviewer: 'agent', verdict: 'no_issue' }] }));
        expect(trustedReviews(cwd, {}).map(r => r.function)).toEqual(['f']);
        expect(trustedReviews(cwd, { independent: true })).toEqual([]);
    });
});
