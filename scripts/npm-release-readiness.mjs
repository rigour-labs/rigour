#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_MAX_ATTEMPTS = 36;
const DEFAULT_INTERVAL_MS = 10_000;

export function discoverPublishedWorkspacePackages(root = process.cwd()) {
  const packagesDir = join(root, 'packages');

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'package.json'))
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, 'utf8')))
    .filter((manifest) => manifest.name?.startsWith('@rigour-labs/') && manifest.private !== true)
    .map((manifest) => manifest.name)
    .sort();
}

export async function findUnavailablePackages({
  packages,
  version,
  registry = DEFAULT_REGISTRY,
  fetchImpl = fetch,
  cacheBust = Date.now(),
}) {
  const baseUrl = registry.replace(/\/$/, '');

  const results = await Promise.all(packages.map(async (packageName) => {
    const encodedName = encodeURIComponent(packageName);
    const encodedVersion = encodeURIComponent(version);
    const url = `${baseUrl}/${encodedName}/${encodedVersion}?write=${cacheBust}`;

    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return packageName;

      const manifest = await response.json();
      return manifest.version === version ? null : packageName;
    } catch {
      return packageName;
    }
  }));

  return results.filter(Boolean);
}

export async function waitForNpmRelease({
  packages,
  version,
  registry = DEFAULT_REGISTRY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  onAttempt = () => {},
}) {
  if (!version) throw new Error('A release version is required');
  if (!packages.length) throw new Error('At least one package is required');

  let missing = [...packages];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    missing = await findUnavailablePackages({
      packages,
      version,
      registry,
      fetchImpl,
      cacheBust: `${Date.now()}-${attempt}`,
    });

    onAttempt({ attempt, maxAttempts, missing });
    if (missing.length === 0) return;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  throw new Error(
    `npm registry did not expose ${version} for: ${missing.join(', ')}`,
  );
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/npm-release-readiness.mjs <version>');
    process.exitCode = 1;
    return;
  }

  const packages = discoverPublishedWorkspacePackages();
  const maxAttempts = Number(process.env.NPM_RELEASE_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
  const intervalMs = Number(process.env.NPM_RELEASE_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  console.log(`Waiting for ${packages.length} Rigour packages at ${version} to become installable...`);
  await waitForNpmRelease({
    packages,
    version,
    maxAttempts,
    intervalMs,
    onAttempt: ({ attempt, missing }) => {
      if (missing.length === 0) {
        console.log(`npm release ${version} is ready after ${attempt} attempt(s).`);
      } else {
        console.log(`Attempt ${attempt}: waiting for ${missing.join(', ')}`);
      }
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
