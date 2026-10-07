#!/usr/bin/env node
/**
 * Point a dist-tag (latest) at a release, package by package, once every package of it installs.
 *
 * Releases are published under the `pending` dist-tag, so `npm install @rigour-labs/cli` and
 * `npm view @rigour-labs/cli version` keep answering with the previous version until the pipeline
 * has seen every package of the new one install. Only then does this move `latest`. A user can
 * never be pointed at a version whose dependencies npm does not serve yet.
 *
 * Safe to run again: a package whose tag already points at the version is left alone.
 *
 *   node scripts/promote-release.mjs <version> [tag]
 *
 * RIGOUR_NPM names a node script to run instead of npm (tests).
 */
import { execFileSync } from 'node:child_process';
import { discoverPublishedWorkspacePackages } from './npm-release-readiness.mjs';

const [version, tag = 'latest'] = process.argv.slice(2);
if (!version) {
  console.error('Usage: node scripts/promote-release.mjs <version> [tag]');
  process.exit(1);
}

const npm = (args) => {
  const [bin, prefix] = process.env.RIGOUR_NPM ? [process.execPath, [process.env.RIGOUR_NPM]] : [process.platform === 'win32' ? 'npm.cmd' : 'npm', []];
  return execFileSync(bin, [...prefix, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' && !process.env.RIGOUR_NPM }).trim();
};

for (const name of discoverPublishedWorkspacePackages()) {
  let current = '';
  try {
    current = npm(['view', name, `dist-tags.${tag}`]);
  } catch {
    // no such tag yet: promote
  }
  if (current === version) {
    console.log(`${name}: ${tag} is already ${version}.`);
    continue;
  }
  npm(['dist-tag', 'add', `${name}@${version}`, tag]);
  console.log(`${name}: ${tag} ${current || '(none)'} -> ${version}.`);
}
