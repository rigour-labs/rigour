#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const packagesDir = path.join(root, 'packages');
const brainPackageDirs = fs.readdirSync(packagesDir)
  .filter((name) => name.startsWith('brain-'))
  .map((name) => path.join(packagesDir, name))
  .filter((dir) => fs.existsSync(path.join(dir, 'package.json')));

if (brainPackageDirs.length === 0) {
  console.error('No brain packages found under packages/.');
  process.exit(1);
}

function getPackFilename(pkgDir, env) {
  const output = execFileSync('npm', ['pack', '--json'], { cwd: pkgDir, encoding: 'utf8', env });
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`npm pack returned invalid JSON for ${pkgDir}`);
  }
  const filename = parsed?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not return a filename for ${pkgDir}`);
  }
  return filename;
}

function getTarListing(tarPath) {
  return execFileSync('tar', ['-tvf', tarPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rigour-brain-pack-'));
const npmCacheDir = path.join(tempRoot, 'npm-cache');
fs.mkdirSync(npmCacheDir, { recursive: true });
const npmEnv = { ...process.env, npm_config_cache: npmCacheDir };
const failures = [];

for (const pkgDir of brainPackageDirs) {
  let pkgJson;
  try {
    pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    failures.push(`${path.basename(pkgDir)}: invalid package.json`);
    continue;
  }
  const pkgName = pkgJson.name || path.basename(pkgDir);
  const packedTar = getPackFilename(pkgDir, npmEnv);
  const tarPath = path.join(pkgDir, packedTar);

  try {
    const listing = getTarListing(tarPath);
    if (pkgName.includes('brain-win-')) {
      const cmdEntry = listing.find((line) => line.includes('package/bin/rigour-brain.cmd'));
      if (!cmdEntry) {
        failures.push(`${pkgName}: missing package/bin/rigour-brain.cmd in tarball`);
      }
      continue;
    }

    const binEntry = listing.find((line) => line.includes('package/bin/rigour-brain'));
    if (!binEntry) {
      failures.push(`${pkgName}: missing package/bin/rigour-brain in tarball`);
      continue;
    }

    const mode = binEntry.split(/\s+/)[0];
    if (!mode.includes('x')) {
      failures.push(`${pkgName}: package/bin/rigour-brain is not executable in tarball (mode ${mode})`);
    }
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}

fs.rmSync(tempRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error('Brain package executable verification failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Brain package executable verification passed for ${brainPackageDirs.length} package(s).`);
