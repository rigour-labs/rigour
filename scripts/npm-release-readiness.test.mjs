import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUnavailablePackages,
  waitForNpmRelease,
} from './npm-release-readiness.mjs';

const TARBALL = 'https://registry.npmjs.org/@rigour-labs/x/-/x.tgz';

function response(status, version) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => ({ version, dist: { tarball: TARBALL } }),
  };
}

/** A fetch that answers the manifest with `manifest` and the tarball HEAD with `tarball`. */
function registry(manifest, tarball = response(200)) {
  return async (url, init) => (init?.method === 'HEAD' ? tarball : manifest(url));
}

test('reports packages whose exact version is not visible', async () => {
  const missing = await findUnavailablePackages({
    packages: ['@rigour-labs/cli', '@rigour-labs/core'],
    version: '6.1.0-beta.2',
    cacheBust: 'test',
    fetchImpl: registry((url) => (
      url.includes('%40rigour-labs%2Fcli')
        ? response(200, '6.1.0-beta.2')
        : response(404)
    )),
  });

  assert.deepEqual(missing, ['@rigour-labs/core']);
});

test('a version whose manifest is visible but whose tarball is not yet fetchable is not published', async () => {
  const missing = await findUnavailablePackages({
    packages: ['@rigour-labs/core'],
    version: '6.6.4',
    cacheBust: 'test',
    fetchImpl: registry(() => response(200, '6.6.4'), response(404)),
  });

  assert.deepEqual(missing, ['@rigour-labs/core']);
});

test('waits until every package in the release is visible', async () => {
  let coreRequests = 0;
  const attempts = [];

  await waitForNpmRelease({
    packages: ['@rigour-labs/cli', '@rigour-labs/core'],
    version: '6.1.0-beta.2',
    maxAttempts: 3,
    intervalMs: 0,
    sleep: async () => {},
    onAttempt: ({ attempt, missing }) => attempts.push([attempt, missing]),
    fetchImpl: registry((url) => {
      if (url.includes('%40rigour-labs%2Fcore')) {
        coreRequests += 1;
        return coreRequests === 1
          ? response(404)
          : response(200, '6.1.0-beta.2');
      }
      return response(200, '6.1.0-beta.2');
    }),
  });

  assert.equal(coreRequests, 2);
  assert.deepEqual(attempts, [
    [1, ['@rigour-labs/core']],
    [2, []],
  ]);
});

test('fails with the unresolved package names after the retry budget', async () => {
  await assert.rejects(
    waitForNpmRelease({
      packages: ['@rigour-labs/core'],
      version: '6.1.0-beta.2',
      maxAttempts: 2,
      intervalMs: 0,
      sleep: async () => {},
      fetchImpl: registry(() => response(404)),
    }),
    /npm registry did not expose 6\.1\.0-beta\.2 for: @rigour-labs\/core/,
  );
});
