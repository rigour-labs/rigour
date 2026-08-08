#!/usr/bin/env node
/**
 * Set every workspace package.json version to the next release version.
 * No-ops packages already at that version (npm version errors otherwise).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/set-release-version.mjs <version>');
  process.exit(1);
}

const packagesDir = join(process.cwd(), 'packages');
const dirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(packagesDir, d.name));

for (const dir of dirs) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name || pkg.version === version) {
    console.log(`${pkg.name ?? dir}: already ${version}`);
    continue;
  }
  execFileSync('npm', ['version', version, '--no-git-tag-version'], {
    cwd: dir,
    stdio: 'inherit',
  });
}
