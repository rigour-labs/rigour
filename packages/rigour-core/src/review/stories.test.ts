import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Failure } from '../types/index.js';
import { recordReviewOutcome } from './agent-fixes.js';
import { readAgentEvents } from './effectiveness.js';
import { recordLessonsServed, recordPrCatches } from './learning-events.js';
import { compactDiff, readStories } from './stories.js';

let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-')); fs.mkdirSync(path.join(cwd, 'src')); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

const finding = (id: string, title: string): Failure => ({ id, title, details: `${title}.`, severity: 'high', files: ['src/a.ts'], line: 2 } as Failure);

describe('compactDiff', () => {
    it('keeps only the changed lines and two lines of context', () => {
        const before = ['a', 'b', 'c', 'old', 'd', 'e', 'f'].join('\n');
        const after = ['a', 'b', 'c', 'new', 'd', 'e', 'f'].join('\n');
        expect(compactDiff(before, after)).toEqual([' b', ' c', '-old', '+new', ' d', ' e']);
    });
});

describe('stories from fixes', () => {
    it('credits a fix to the stage that first reported it, with the code change', () => {
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), "fetch(url, { headers });\n");
        recordReviewOutcome(cwd, [finding('semantic-bugs', 'Credential header follows redirects')], ['src/a.ts'], 'edit');
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), "fetch(url, { headers, redirect: 'error' });\n");
        recordReviewOutcome(cwd, [], ['src/a.ts'], 'stop');

        const [story] = readStories(cwd);
        expect(story).toMatchObject({ stage: 'edit', file: 'src/a.ts', rule: 'semantic-bugs', title: 'Credential header follows redirects' });
        expect(story.diff).toEqual(['-fetch(url, { headers });', "+fetch(url, { headers, redirect: 'error' });", ' ']);
    });

    it('writes no story for a finding someone dismissed, even after its file changed', async () => {
        const { dismissFinding, findingKey } = await import('./quiet.js');
        const f = finding('semantic-bugs', 'Looks risky');
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'x\n');
        recordReviewOutcome(cwd, [f], ['src/a.ts'], 'review');
        dismissFinding(cwd, findingKey(f), 'intended');
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'y\n');
        recordReviewOutcome(cwd, [], ['src/a.ts'], 'review');
        expect(readStories(cwd)).toEqual([]);
    });

    it('writes no story while the finding is still open', () => {
        fs.writeFileSync(path.join(cwd, 'src/a.ts'), 'x\n');
        recordReviewOutcome(cwd, [finding('semantic-bugs', 'X')], ['src/a.ts'], 'review');
        expect(readStories(cwd)).toEqual([]);
    });
});

describe('learning events', () => {
    it('records lessons served and PR catches, and nothing when there are none', () => {
        recordLessonsServed(cwd, 'recall', []);
        recordPrCatches(cwd, []);
        expect(readAgentEvents(cwd)).toEqual([]);
        recordLessonsServed(cwd, 'review', ['Never follow redirects with credentials', 'Never follow redirects with credentials']);
        recordPrCatches(cwd, [finding('semantic-bugs', 'Unbounded query')]);
        expect(readAgentEvents(cwd)).toEqual([
            expect.objectContaining({ type: 'lessons_served', via: 'review', lessons: ['Never follow redirects with credentials'] }),
            expect.objectContaining({ type: 'pr_catches', findings: [{ rule: 'semantic-bugs', title: 'Unbounded query', file: 'src/a.ts' }] }),
        ]);
    });
});
