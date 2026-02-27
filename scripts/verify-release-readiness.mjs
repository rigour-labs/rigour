#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const REQUIRED_BRAIN_PACKAGES = [
  '@rigour-labs/brain-darwin-arm64',
  '@rigour-labs/brain-darwin-x64',
  '@rigour-labs/brain-linux-x64',
  '@rigour-labs/brain-linux-arm64',
  '@rigour-labs/brain-win-x64',
];

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function npmViewJson(pkg, field) {
  const args = ['view', pkg];
  if (field) args.push(field);
  args.push('--json');
  const raw = run('npm', args);
  return JSON.parse(raw);
}

function fail(message) {
  console.error(`✘ ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`✓ ${message}`);
}

function maybeCheckBrew() {
  try {
    const info = run('brew', ['info', 'rigour-labs/tap/rigour']);
    pass('Homebrew tap formula is resolvable');
    const firstLine = info.split(/\r?\n/)[0] || '';
    console.log(`  ${firstLine}`);
  } catch {
    console.log('! brew not available in this environment, skipped Homebrew formula check');
  }
}

try {
  const cliVersion = npmViewJson('@rigour-labs/cli', 'version');
  const coreVersion = npmViewJson('@rigour-labs/core', 'version');

  if (!cliVersion || !coreVersion) {
    fail('Unable to resolve CLI/Core versions from npm');
  } else {
    pass(`CLI version on npm: ${cliVersion}`);
    pass(`Core version on npm: ${coreVersion}`);
  }

  if (cliVersion && coreVersion && cliVersion !== coreVersion) {
    fail(`Version mismatch: cli=${cliVersion}, core=${coreVersion}`);
  }

  const coreOptionalDeps = npmViewJson('@rigour-labs/core', 'optionalDependencies') || {};
  for (const pkg of REQUIRED_BRAIN_PACKAGES) {
    const listed = coreOptionalDeps[pkg];
    if (!listed) {
      fail(`Missing optional dependency in @rigour-labs/core: ${pkg}`);
      continue;
    }

    const published = npmViewJson(pkg, 'version');
    if (!published) {
      fail(`Brain package not published: ${pkg}`);
      continue;
    }

    pass(`${pkg} published at ${published}`);
    if (cliVersion && published !== cliVersion) {
      fail(`Version mismatch for ${pkg}: expected ${cliVersion}, got ${published}`);
    }
  }

  maybeCheckBrew();
} catch (error) {
  fail(`Release readiness check failed: ${error.message}`);
}

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('\nRelease readiness checks passed.');
