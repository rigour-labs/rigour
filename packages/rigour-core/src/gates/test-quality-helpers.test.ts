import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestQualityGate } from './test-quality.js';

let repo: string;
const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), body);
};
const noAssertion = async () => {
    const failures = await new TestQualityGate().run({ cwd: repo });
    return failures.flatMap(f => f.details.split('\n').filter(l => l.includes('[no-assertion]')).map(l => `${f.files?.[0]} ${l.trim().split(':')[0]}`));
};

beforeEach(() => { repo = fs.mkdtempSync(path.join(os.tmpdir(), 'test-quality-helpers-')); });
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('a test that asserts through a helper', () => {
    it('counts an imported expect/assert/should helper, and a helper whose own body asserts, imported or local', async () => {
        write('test/support/orders.ts', `import { expect } from 'vitest';
export function checkTotals(order: { total: number }) {
    expect(order.total).toBeGreaterThan(0);
}
export const sameRows = (a: unknown[], b: unknown[]) => expect(a).toEqual(b);
export function makeOrder() { return { total: 1 }; }
`);
        write('src/orders.test.ts', `import { it } from 'vitest';
import { expectValidOrder } from 'some-assertions';
import { assertRedirect as redirects } from '../test/support/http.js';
import { checkTotals, sameRows, makeOrder } from '../test/support/orders.js';
function local(x: number) {
    assert.ok(x > 0);
}
it('named helper', () => {
    expectValidOrder(makeOrder());
});
it('renamed helper', () => {
    redirects('/a');
});
it('helper whose body asserts', () => {
    checkTotals(makeOrder());
});
it('arrow helper whose body asserts', () => {
    sameRows([1], [1]);
});
it('local helper', () => {
    local(1);
});
it('only builds', () => {
    makeOrder();
});
`);
        expect(await noAssertion()).toEqual(['src/orders.test.ts L23']);
    });

    it('does not count a helper that only builds, or a name that merely contains expect', async () => {
        write('src/a.test.ts', `import { it } from 'vitest';
import { unexpectedly } from './util';
it('calls a name containing expect', () => {
    unexpectedly();
});
`);
        write('src/util.ts', 'export function unexpectedly() { return 1; }\n');
        expect(await noAssertion()).toEqual(['src/a.test.ts L3']);
    });

    it('counts a Python base-class method whose body asserts, called on self, and an imported assert_ helper', async () => {
        write('app/lib/test_classes.py', `from contextlib import contextmanager


class AppTestCase:
    @contextmanager
    def capture_events(self, expected: int):
        events = []
        yield events
        self.assertEqual(len(events), expected)

    def example_user(self, name):
        return name
`);
        write('app/lib/checks.py', 'def assert_valid(x):\n    return x\n');
        write('app/tests/test_events.py', `from app.lib.test_classes import AppTestCase
from app.lib.checks import assert_valid


class EventTest(AppTestCase):
    def test_sends_nothing(self) -> None:
        user = self.example_user("a")
        with (
            self.capture_events(expected=0),
        ):
            user.upper()

    def test_imported_helper(self) -> None:
        assert_valid(1)

    def test_only_builds(self) -> None:
        self.example_user("b")
`);
        expect(await noAssertion()).toEqual(['app/tests/test_events.py L16']);
    });
});

