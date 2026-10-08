import assert from 'node:assert/strict';
import test from 'node:test';

import { distTagFor } from './publish-packages.mjs';

test('a stable release waits under pending; a prerelease goes to its channel', () => {
  assert.equal(distTagFor('6.9.0', ''), 'pending');
  assert.equal(distTagFor('6.9.0', 'undefined'), 'pending'); // what an empty semantic-release channel renders as
  assert.equal(distTagFor('6.9.0-rc.1', 'next'), 'next');
  assert.equal(distTagFor('6.9.0-beta.3', 'beta'), 'beta');
  assert.equal(distTagFor('6.9.0-rc.2', ''), 'rc'); // no channel named: the prerelease's own name
  assert.equal(distTagFor('6.9.0-rc.2', 'null'), 'rc');
});
