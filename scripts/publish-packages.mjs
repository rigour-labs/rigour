#!/usr/bin/env node
/**
 * Publish @rigour-labs/* workspace packages via pnpm so workspace:* deps are
 * rewritten to real semver ranges in the published tarballs (npm publish alone
 * leaves workspace: protocol and breaks npx installs). A package already
 * published at this version is skipped, so a retry is safe.
 *
 * It does not wait for npm to serve the new versions: npm can take many minutes,
 * and a slow registry must never fail a release that has already happened. The
 * pipeline's "Verify npm release is installable" step does that wait.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The npm dist-tag a version is published under: `pending` for a stable release (the pipeline moves `latest` to it once
 * the release gates pass), and the release's channel for a prerelease (`next` for a release candidate, `beta` from dev),
 * falling back to the prerelease's own name when semantic-release gives no channel.
 */
export function distTagFor(version, channel) {
  const prerelease = String(version).split('-')[1];
  if (!prerelease) return 'pending';
  const named = String(channel ?? '').trim();
  return named && named !== 'undefined' && named !== 'null' ? named : prerelease.split('.')[0];
}

function main() {
  const root = process.cwd();
  const cliPackage = JSON.parse(readFileSync(join(root, 'packages/rigour-cli/package.json'), 'utf8'));
  const distTag = distTagFor(cliPackage.version, process.argv[2]);

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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
