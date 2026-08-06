#!/usr/bin/env node
/**
 * Publish all non-private workspace packages with npm (not pnpm) so GitHub
 * OIDC trusted publishing env vars reach the publish process.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packagesDir = path.join(root, 'packages');
const packageDirs = fs.readdirSync(packagesDir)
  .map((name) => path.join(packagesDir, name))
  .filter((dir) => fs.existsSync(path.join(dir, 'package.json')));

const failures = [];
let published = 0;

for (const dir of packageDirs) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.private) {
    continue;
  }
  if (!pkg.name?.startsWith('@rigour-labs/')) {
    console.log(`Skipping ${pkg.name ?? path.basename(dir)} (not published by org release token).`);
    continue;
  }

  const name = pkg.name || path.basename(dir);
  console.log(`\nPublishing ${name} from ${path.relative(root, dir)}...`);
  try {
    execFileSync('npm', ['publish', '--access', 'public', '--provenance'], {
      cwd: dir,
      stdio: 'inherit',
      env: process.env,
    });
    published += 1;
  } catch (error) {
    failures.push(name);
  }
}

if (failures.length > 0) {
  console.error(`\nPublish failed for: ${failures.join(', ')}`);
  process.exit(1);
}

console.log(`\nPublished ${published} package(s).`);
