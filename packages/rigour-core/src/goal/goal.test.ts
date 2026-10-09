import { describe, expect, it } from 'vitest';
import { parseDiff } from '../utils/diff.js';
import { goalFailures, hasCheckableGoal, modelGoalItems, parseGoal } from './goal.js';

const BODY = [
    'Adds the goal check.',
    '',
    '## Done when',
    '- [ ] `parseGoal` reads the description',
    '- [x] `docs/GOAL.md` explains it',
    '- [ ] reviewers are happy',
    '',
    '## Scope',
    '- `packages/core/src/goal/`',
    '- packages/cli/src/commands/review.ts',
    '',
    '**Out of scope**',
    '- `packages/studio/**`',
    '',
    'Invariants:',
    '- a description without a goal never blocks',
    '',
    '## Testing',
    '- `src/other.ts` is not scope',
].join('\n');

function diffOf(files: Record<string, string[]>, deleted: string[] = []): string {
    const parts = Object.entries(files).map(([file, added]) =>
        `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,0 +1,${added.length} @@\n${added.map(l => `+${l}`).join('\n')}\n`);
    const gone = deleted.map(file => `diff --git a/${file} b/${file}\ndeleted file mode 100644\n--- a/${file}\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n`);
    return [...parts, ...gone].join('');
}

function check(body: string, diff: string) {
    return goalFailures(parseGoal(body), parseDiff(diff), diff);
}

describe('parseGoal', () => {
    it('reads the sections the author declared, by markdown, bold and label headings', () => {
        const goal = parseGoal(BODY);
        expect(goal.scope).toEqual(['packages/core/src/goal/', 'packages/cli/src/commands/review.ts']);
        expect(goal.outOfScope).toEqual(['packages/studio/**']);
        expect(goal.invariants).toEqual(['a description without a goal never blocks']);
        expect(goal.doneWhen.map(i => [i.paths, i.symbols])).toEqual([[[], ['parseGoal']], [['docs/GOAL.md'], []], [[], []]]);
    });

    it('reads the headings teams already write a goal under as Done when, and never a procedure checklist', () => {
        for (const heading of ['Acceptance criteria', 'Definition of done', 'Success criteria', 'Done when']) {
            expect(parseGoal(`## ${heading}\n- [x] \`run\` is called`).doneWhen.map(i => i.symbols)).toEqual([['run']]);
        }
        for (const heading of ['Test plan', 'Review checklist']) expect(parseGoal(`## ${heading}\n- [ ] \`run\` is called`).doneWhen).toEqual([]);
    });

    it('stops a section at the next heading, so another section\'s paths are not scope', () => {
        expect(parseGoal(BODY).scope).not.toContain('src/other.ts');
    });

    it('declares nothing checkable for a description without the headings, or with only prose items', () => {
        expect(hasCheckableGoal(parseGoal('Fixes the thing.\n\n- tidy up\n- `src/a.ts` too'))).toBe(false);
        expect(hasCheckableGoal(parseGoal('## Done when\n- it works'))).toBe(false);
        expect(hasCheckableGoal(parseGoal(BODY))).toBe(true);
    });
});

describe('goalFailures', () => {
    it('passes a change inside its scope that does every named item', () => {
        const diff = diffOf({ 'packages/core/src/goal/goal.ts': ['export function parseGoal() {}'], 'docs/GOAL.md': ['# Goal'] });
        // docs/GOAL.md is outside Scope but named by Done when: the item itself puts it in the goal.
        expect(check(BODY, diff)).toEqual([]);
    });

    it('blocks a changed file outside the declared scope, on its first changed line', () => {
        const diff = diffOf({ 'packages/core/src/goal/goal.ts': ['parseGoal'], 'docs/GOAL.md': ['x'], 'packages/core/src/other.ts': ['a', 'b'], 'README.md': ['x'] });
        const failures = check(BODY, diff).filter(f => f.id === 'goal-scope');
        expect(failures.map(f => [f.files, f.line])).toEqual([[['README.md'], 1], [['packages/core/src/other.ts'], 1]]);
    });

    it('blocks a changed file inside the declared out of scope, naming the pattern', () => {
        const failures = check(BODY, diffOf({ 'packages/core/src/goal/goal.ts': ['parseGoal'], 'packages/studio/src/App.tsx': ['x'] }));
        expect(failures.find(f => f.files?.[0] === 'packages/studio/src/App.tsx')?.title).toContain('`packages/studio/**`');
    });

    it('counts a deleted file as changed', () => {
        const failures = check('## Out of scope\n- `legacy/`', diffOf({}, ['legacy/old.ts']));
        expect(failures.map(f => f.files)).toEqual([['legacy/old.ts']]);
    });

    it('never counts tests or lockfiles as scope drift', () => {
        const diff = diffOf({ 'packages/core/src/goal/goal.ts': ['parseGoal'], 'packages/core/src/other.test.ts': ['x'], 'test/fixture.ts': ['x'], 'pnpm-lock.yaml': ['x'] });
        expect(check('## Scope\n- `packages/core/src/goal/`', diff)).toEqual([]);
    });

    it('blocks a done-when item whose named file the change never touches, and only notes a named symbol', () => {
        const failures = check(BODY, diffOf({ 'packages/core/src/goal/goal.ts': ['const unrelated = 1;'] })).filter(f => f.id === 'goal-done-when');
        expect(failures.map(f => [f.title, !!f.advisory])).toEqual([
            ['`parseGoal` named in "Done when", not changed by this pull request: check it\'s met', true],
            ['"Done when" names `docs/GOAL.md`, and the change never touches it', false],
        ]);
    });

    it('keeps an item stating a preserved property a note, never a block', () => {
        for (const item of ['`isAdminRequest` is still the only Bearer check', '`resolveReviewer` behaviour unchanged', '`retryCounts` covers every writer', '`run` remains the only entry']) {
            const failures = check(`## Done when\n- ${item}`, diffOf({ 'a.ts': ['x'] }));
            expect(failures).toHaveLength(1);
            expect(failures[0].advisory).toBe(true);
        }
    });

    it('reads member access as a symbol, never a file the change must touch', () => {
        for (const token of ['JSON.parse', 'Promise.all', 'window.location', 'res.status', 'order.customerId', 'user.email']) {
            const goal = parseGoal(`## Done when\n- \`${token}\` reaches checkout`);
            expect(goal.doneWhen[0]).toMatchObject({ paths: [], symbols: [token] });
            expect(check(`## Done when\n- \`${token}\` reaches checkout`, diffOf({ 'src/checkout.ts': [`const x = ${token};`] }))).toEqual([]);
        }
        expect(parseGoal('## Done when\n- `package.json`, `events.manifest.sha256` and `src/` updated').doneWhen[0].paths).toEqual(['package.json', 'events.manifest.sha256', 'src/']);
    });

    it('reads a bare file name as a file only when the repository has it', () => {
        const exists = (name: string) => name === 'package.json';
        const goal = parseGoal('## Done when\n- `package.json` bumped\n- `res.json` returns the body', exists);
        expect(goal.doneWhen.map(i => [i.paths, i.symbols])).toEqual([[['package.json'], []], [[], ['res.json']]]);
        const failures = goalFailures(goal, parseDiff(diffOf({ 'src/a.ts': ['x'] })), diffOf({ 'src/a.ts': ['x'] }));
        expect(failures.map(f => [f.title.includes('package.json'), !!f.advisory])).toEqual([[true, false], [false, true]]); // package.json blocks, res.json is a note
        expect(parseGoal('## Scope\n- `src/x/`\n- `res.json`', exists).scope).toEqual(['src/x/']);
    });

    it('never reads a URL or an app route as a file of the repository', () => {
        const goal = parseGoal('## Done when\n- `a.e2e.ts` asserts the CTA href is `https://<host>/checkout?[id=…&]origin=x`\n- `/app/dashboard` shows the plan\n- `http://app.local:3000/app` loads', () => true);
        expect(goal.doneWhen.map(i => i.paths)).toEqual([['a.e2e.ts'], [], []]);
        expect(check('## Scope\n- `/app/`\n- `https://example.com/x`', diffOf({ 'src/a.ts': ['x'] }))).toEqual([]);
        expect(parseGoal('## Scope\n- `src/routes/(app)/settings/+page.svelte`\n- `$lib/server/`').scope).toEqual(['src/routes/(app)/settings/+page.svelte', '$lib/server/']);
    });

    it('never counts deleting a generated file as scope drift', () => {
        const diff = diffOf({ 'src/a.ts': ['x'] }, ['lib/client.gen.ts', 'lib/hand.ts']);
        const failures = goalFailures(parseGoal('## Scope\n- `src/`'), parseDiff(diff), diff, file => file.includes('.gen.'));
        expect(failures.map(f => f.files)).toEqual([['lib/hand.ts']]);
    });

    it('never counts snapshots, changelogs or release notes as scope drift', () => {
        const diff = diffOf({ 'src/a.ts': ['x'], 'src/__snapshots__/a.test.ts.snap': ['x'], 'ui/view.snap': ['x'], 'CHANGELOG.md': ['x'], 'docs/releases/6.9.0.md': ['x'] });
        expect(check('## Scope\n- `src/`', diff)).toEqual([]);
    });

    it('matches a symbol as a whole word, on an added or a removed line', () => {
        const removed = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,0 @@\n-function parseGoal() {}\n';
        expect(check('## Done when\n- `parseGoal` is removed', removed)).toEqual([]);
        expect(check('## Done when\n- `parseGoal` is added', diffOf({ 'a.ts': ['parseGoalish()'] }))).toHaveLength(1);
    });

    it('says nothing when the description declares no goal', () => {
        expect(check('Just a fix.', diffOf({ 'anything.ts': ['x'] }))).toEqual([]);
    });
});

describe('modelGoalItems', () => {
    it('asks a model only about what the deterministic check cannot prove: done items naming no file, and invariants', () => {
        const goal = parseGoal('## Done when\n- `src/a.ts` exists\n- `parseGoal` reads it\n- it works offline\n\n## Invariants\n- one send per person');
        expect(modelGoalItems(goal)).toEqual([
            { kind: 'done', text: '`parseGoal` reads it' },
            { kind: 'done', text: 'it works offline' },
            { kind: 'invariant', text: 'one send per person' },
        ]);
    });

    it('asks about at most a dozen items', () => {
        const goal = parseGoal(`## Invariants\n${Array.from({ length: 20 }, (_, i) => `- rule ${i}`).join('\n')}`);
        expect(modelGoalItems(goal)).toHaveLength(12);
    });
});
