import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overTitle, releaseLevel } from './commit-types.mjs';

test('reads what a conventional commit releases', () => {
    assert.equal(releaseLevel('fix: a'), 1);
    assert.equal(releaseLevel('perf(core): a'), 1);
    assert.equal(releaseLevel('feat: a'), 2);
    assert.equal(releaseLevel('feat!: a'), 3);
    assert.equal(releaseLevel('fix: a\n\nBREAKING CHANGE: b'), 3);
    assert.equal(releaseLevel('chore: a'), 0);
    assert.equal(releaseLevel('Merge branch main'), 0);
});

test('fails a commit that releases more than the title, and passes the rest', () => {
    assert.deepEqual(overTitle('perf: the same content is not reviewed again', ['feat: the same content is not reviewed again', 'fix: x', 'test: y']).map(o => o.subject), ['feat: the same content is not reviewed again']);
    assert.deepEqual(overTitle('feat: a', ['feat: a', 'fix: b', 'docs: c']), []);
    assert.deepEqual(overTitle('fix: a', ['fix: a', 'chore: b']), []);
});
