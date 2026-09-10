#!/usr/bin/env node
/**
 * Publish @rigour-labs/* workspace packages via pnpm so workspace:* deps are
 * rewritten to real semver ranges in the published tarballs (npm publish alone
 * leaves workspace: protocol and breaks npx installs).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const cliPackage = JSON.parse(readFileSync(join(root, 'packages/rigour-cli/package.json'), 'utf8'));
const prerelease = String(cliPackage.version).split('-')[1];
const distTag = prerelease ? prerelease.split('.')[0] : 'latest';

console.log(`Publishing @rigour-labs/* packages with npm dist-tag ${distTag}...`);

try {
  execFileSync(
    'pnpm',
    [
      '--filter', '@rigour-labs/*',
      'publish',
      '--no-git-checks',
      '--access', 'public',
      '--provenance',
      '--tag', distTag,
    ],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
} catch {
  process.exit(1);
}

console.log('\nPublished @rigour-labs/* packages.');
