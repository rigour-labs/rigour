#!/usr/bin/env node
/**
 * The gates a release passes under `pending` before anyone can move `latest` to it: what a user would do on a clean
 * machine, done to the published packages, not to the build in this checkout.
 *
 *   1. Clean install: every published package at the version, from an empty npm cache, with no deprecation warning.
 *   2. The commands: init, check, review --base --json (says what it checked), brief --json, thread --json.
 *   3. Upgrade: a repository set up with the previous `latest` opens with the new version, its files kept as they were.
 *   4. Secrets: no credential-shaped string in any published tarball.
 *
 * Everything runs in throwaway folders with its own HOME, RIGOUR_HOME and npm cache: nothing touches the machine's own.
 *
 *   node scripts/release-gates.mjs <version> [previous]
 *
 * `previous` defaults to the CLI's current `latest`. Exit 1 on the first failed gate, with what failed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPublishedWorkspacePackages } from './npm-release-readiness.mjs';

/** `npm warn deprecated <pkg>: <why>` lines in an install's output. */
export function deprecationWarnings(output) {
  return output.split('\n').map(line => line.trim()).filter(line => /^npm warn deprecated /i.test(line));
}

/** Credential-shaped strings: the kinds a release must never carry, whoever's they are. */
const SECRET_PATTERNS = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{60,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{40,}\b/],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{40,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
];

/** The credential-shaped strings in a file's text, by kind. */
export function secretFindings(text) {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}

/** Every file under a folder, relative to it with '/' separators, with a hash of its contents: what an upgrade must leave as it was. */
export function snapshot(dir, skip = ['.git', 'node_modules']) {
  const files = {};
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      if (skip.includes(name)) continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(dir, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex'); // '/' on every platform
    }
  };
  walk(dir);
  return files;
}

/** What an upgrade changed or lost: a file the old version wrote that is missing or different. */
export function lostOrChanged(before, after, mayChange = []) {
  return Object.keys(before).filter(file => !mayChange.some(pattern => pattern.test(file)) && after[file] !== before[file]);
}

/**
 * Every throwaway folder this run made: removed when it exits, pass or fail, and when it is interrupted (Ctrl-C, a CI
 * cancel), which skips `exit` handlers on its own; so a run leaves no install behind.
 */
const sandboxes = [];
function removeSandboxes() {
  for (const root of sandboxes.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // a folder the system holds open is left to the system's temp cleanup
    }
  }
}
process.on('exit', removeSandboxes);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    removeSandboxes();
    process.exit(code);
  });
}

/** A throwaway folder with its own HOME, RIGOUR_HOME and npm cache, removed when this run ends however it ends. */
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rigour-gates-'));
  sandboxes.push(root);
  const home = join(root, 'home');
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, RIGOUR_HOME: join(home, '.rigour'),
    npm_config_cache: join(root, 'npm-cache'), npm_config_update_notifier: 'false',
    RIGOUR_UPDATE_CHECK: '0', DO_NOT_TRACK: '1', RIGOUR_TELEMETRY: '0', CI: '1',
  };
  mkdirSync(home, { recursive: true });
  return { root, env };
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...options });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const failures = [];

/** A gate failed: said now, counted for the exit code; the other gates still run unless `stop`. */
function fail(gate, why, stop = false) {
  console.error(`✘ ${gate}: ${why}`);
  failures.push(gate);
  if (stop) process.exit(1);
}

function pass(gate, detail = '') {
  console.log(`✔ ${gate}${detail ? `: ${detail}` : ''}`);
}

/** A git repository with one commit on main and a change on a branch, for the commands to work on. */
function repository(dir, env) {
  const git = (...args) => run('git', args, { cwd: dir, env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'gates@example.com');
  git('config', 'user.name', 'gates');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'AGENTS.md'), '- Every handler in `src/jobs/` must validate its payload with `parsePayload()` before using it.\n');
  mkdirSync(join(dir, 'src', 'jobs'), { recursive: true });
  writeFileSync(join(dir, 'src', 'jobs', 'sweep.ts'), 'export const sweep = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/sweep');
  writeFileSync(join(dir, 'src', 'jobs', 'sweep.ts'), 'export const sweep = 2;\n');
  git('commit', '-qam', 'change');
}

function install(dir, env, specs) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gates', version: '0.0.0', private: true }));
  return run('npm', ['install', '--no-audit', '--no-fund', ...specs], { cwd: dir, env });
}

function main() {
  const [version, previousArg] = process.argv.slice(2);
  if (!version) {
    console.error('Usage: node scripts/release-gates.mjs <version> [previous]');
    process.exit(1);
  }
  const packages = discoverPublishedWorkspacePackages().filter(name => name.startsWith('@rigour-labs/') && !name.includes('/brain-'));
  const previous = previousArg || run('npm', ['view', '@rigour-labs/cli', 'dist-tags.latest'], {}).stdout.trim();

  // 1. Clean install from an empty cache: no deprecation warning.
  const clean = sandbox();
  const app = join(clean.root, 'app');
  mkdirSync(app, { recursive: true });
  const installed = install(app, clean.env, packages.map(name => `${name}@${version}`));
  if (installed.code !== 0) fail('clean install', installed.out.slice(-2000), true);
  const warnings = deprecationWarnings(installed.out);
  if (warnings.length) fail('clean install', `deprecation warnings:\n  ${warnings.join('\n  ')}`);
  else pass('clean install', `${packages.join(', ')} at ${version}, no deprecation warning`);

  // 2. The commands, in a repository with a change on a branch.
  const rigour = join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'rigour.cmd' : 'rigour');
  const repo = join(clean.root, 'repo');
  mkdirSync(repo, { recursive: true });
  repository(repo, clean.env);
  const cli = (...args) => run(rigour, args, { cwd: repo, env: clean.env });
  const versionOut = cli('--version');
  if (!versionOut.out.includes(version)) fail('version', `rigour --version says ${versionOut.out.trim()}`);
  for (const args of [['init'], ['check']]) {
    const result = cli(...args);
    if (result.code > 1) fail(`rigour ${args.join(' ')}`, `exit ${result.code}\n${result.out.slice(-1500)}`);
  }
  const review = cli('review', '--base', 'main', '--json');
  let reviewJson;
  try {
    reviewJson = JSON.parse(review.stdout); // progress goes to stderr: stdout is the JSON alone
  } catch {
    fail('rigour review --base main --json', `stdout is not JSON:\n${review.stdout.slice(0, 1500)}`);
  }
  if (reviewJson && !reviewJson.checked) fail('rigour review --base main --json', 'the output does not say what it checked');
  const json = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const brief = cli('brief', 'validate the sweep payload', '--files', 'src/jobs/sweep.ts', '--json');
  if (brief.code !== 0 || !json(brief.stdout)?.items?.some(item => item.text.includes('parsePayload'))) fail('rigour brief --json', brief.out.slice(0, 1500));
  const thread = cli('thread', '--json');
  if (thread.code !== 0 || !json(thread.stdout)?.events?.some(event => event.kind === 'brief')) fail('rigour thread --json', thread.out.slice(0, 1500));
  if (!failures.some(gate => gate.startsWith('rigour') || gate === 'version')) pass('commands', 'init, check, review --base --json, brief --json, thread --json');

  // 3. Upgrade: set up with the previous latest, then open with this version; nothing the old one wrote is lost.
  if (previous && previous !== version) {
    const up = sandbox();
    const upApp = join(up.root, 'app');
    const upRepo = join(up.root, 'repo');
    for (const dir of [upApp, upRepo]) mkdirSync(dir, { recursive: true });
    repository(upRepo, up.env);
    const old = install(upApp, up.env, [`@rigour-labs/cli@${previous}`]);
    if (old.code !== 0) fail('upgrade', `could not install ${previous}:\n${old.out.slice(-1500)}`, true);
    const upBin = join(upApp, 'node_modules', '.bin', process.platform === 'win32' ? 'rigour.cmd' : 'rigour');
    run(upBin, ['init'], { cwd: upRepo, env: up.env });
    run(upBin, ['check'], { cwd: upRepo, env: up.env });
    const before = snapshot(upRepo);
    const beforeHome = existsSync(up.env.RIGOUR_HOME) ? snapshot(up.env.RIGOUR_HOME) : {};
    const next = install(upApp, up.env, [`@rigour-labs/cli@${version}`]);
    if (next.code !== 0) fail('upgrade', `could not install ${version} over ${previous}:\n${next.out.slice(-1500)}`, true);
    const checked = run(upBin, ['check'], { cwd: upRepo, env: up.env });
    if (checked.code > 1) fail('upgrade', `rigour check after the upgrade exits ${checked.code}:\n${checked.out.slice(-1500)}`);
    // A check rewrites its own report and run records; everything else the old version wrote must be as it was.
    const lost = lostOrChanged(before, snapshot(upRepo), [/^rigour-report\.json$/, /^\.rigour\//, /^package(-lock)?\.json$/]);
    const lostHome = existsSync(up.env.RIGOUR_HOME) ? Object.keys(beforeHome).filter(file => !(file in snapshot(up.env.RIGOUR_HOME))) : Object.keys(beforeHome);
    const dotRigour = Object.keys(before).filter(file => file.startsWith('.rigour/'));
    const missing = dotRigour.filter(file => !existsSync(join(upRepo, file)));
    if (lost.length || lostHome.length) fail('upgrade', `changed or lost: ${[...lost, ...lostHome.map(f => `~/.rigour/${f}`)].join(', ')}`);
    else if (missing.length) fail('upgrade', `.rigour files gone after the upgrade: ${missing.join(', ')}`);
    else pass('upgrade', `${previous} → ${version}, ${Object.keys(before).length} repository files and ${Object.keys(beforeHome).length} home files kept`);
  } else {
    pass('upgrade', `skipped: no previous version to upgrade from (${previous || 'none'})`);
  }

  // 4. Secrets: no credential-shaped string in any published tarball.
  const packed = join(clean.root, 'packed');
  mkdirSync(packed, { recursive: true });
  const findings = [];
  for (const name of packages) {
    const pack = run('npm', ['pack', `${name}@${version}`, '--pack-destination', packed], { cwd: packed, env: clean.env });
    if (pack.code !== 0) fail('secret scan', `could not fetch ${name}@${version}:\n${pack.out.slice(-800)}`, true);
  }
  for (const tarball of readdirSync(packed).filter(file => file.endsWith('.tgz'))) {
    const into = join(packed, tarball.replace(/\.tgz$/, ''));
    mkdirSync(into, { recursive: true });
    run('tar', ['xzf', join(packed, tarball), '-C', into], {});
    for (const [file] of Object.entries(snapshot(into))) {
      const kinds = secretFindings(readFileSync(join(into, file), 'utf8'));
      if (kinds.length) findings.push(`${tarball}: ${file} (${kinds.join(', ')})`);
    }
  }
  if (findings.length) fail('secret scan', findings.join('\n  '));
  else pass('secret scan', `${packages.length} tarballs, no credential-shaped string`);
  if (failures.length) {
    console.error(`\n${failures.length} gate(s) failed: ${[...new Set(failures)].join(', ')}. latest must not move to ${version}.`);
    process.exit(1);
  }
  console.log(`\nEvery gate passed for ${version}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
