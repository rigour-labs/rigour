#!/usr/bin/env node
/**
 * Publish @rigour-labs/* workspace packages via pnpm so workspace:* deps are
 * rewritten to real semver ranges in the published tarballs (npm publish alone
 * leaves workspace: protocol and breaks npx installs).
 */
import { execFileSync } from 'node:child_process';

const root = process.cwd();

console.log('Publishing @rigour-labs/* packages with pnpm (resolves workspace: deps)...');

try {
  execFileSync(
    'pnpm',
    [
      '--filter', '@rigour-labs/*',
      'publish',
      '--no-git-checks',
      '--access', 'public',
      '--provenance',
    ],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
} catch {
  process.exit(1);
}

console.log('\nPublished @rigour-labs/* packages.');
