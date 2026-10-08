import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { discoverPublishedWorkspacePackages } from './npm-release-readiness.mjs';

const root = process.cwd();
const dirs = ['rigour-core', 'rigour-cli', 'rigour-mcp'];

test('no published package ships its compiled tests', () => {
  const published = new Set(discoverPublishedWorkspacePackages(root));
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));
    assert.ok(published.has(pkg.name), `${pkg.name} is published`);
    for (const pattern of ['!dist/**/*.test.js', '!dist/**/*.test.d.ts', '!dist/**/*.test.js.map']) {
      assert.ok(pkg.files.includes(pattern), `${pkg.name} excludes ${pattern}`);
    }
    // With a build present, what npm would publish is checked directly.
    if (!existsSync(join(root, 'packages', dir, 'dist'))) continue;
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const [packed] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: join(root, 'packages', dir), encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'ignore'] }));
    const tests = packed.files.map(f => f.path).filter(path => /\.test\./.test(path));
    assert.deepEqual(tests, [], `${pkg.name} would publish ${tests.length} test file(s)`);
  }
});
