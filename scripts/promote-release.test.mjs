import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./promote-release.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

/** An npm that answers `view` from a table of current tags and logs every `dist-tag add`. */
function fakeNpm(current) {
  const dir = mkdtempSync(join(tmpdir(), 'promote-'));
  const log = join(dir, 'calls.log');
  const bin = join(dir, 'npm.mjs');
  writeFileSync(bin, `import { appendFileSync } from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
const current = ${JSON.stringify(current)};
if (cmd === 'view') { const v = current[rest[0]]; if (v === undefined) process.exit(1); process.stdout.write(v + '\\n'); }
else { appendFileSync(${JSON.stringify(log)}, [cmd, ...rest].join(' ') + '\\n'); }
`);
  return { bin, calls: () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } } };
}

test('moves latest to the release for each package that is not there yet, and leaves the rest', () => {
  const npm = fakeNpm({ '@rigour-labs/cli': '6.7.1', '@rigour-labs/core': '6.7.0' });
  const run = spawnSync(process.execPath, [script, '6.7.1'], { cwd: root, encoding: 'utf8', env: { ...process.env, RIGOUR_NPM: npm.bin } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(npm.calls(), /^dist-tag add @rigour-labs\/core@6\.7\.1 latest$/m);
  assert.doesNotMatch(npm.calls(), /@rigour-labs\/cli@/); // already latest: untouched
  assert.match(npm.calls(), /@rigour-labs\/mcp@6\.7\.1 latest/); // no tag yet: promoted
});

test('refuses to run without a version', () => {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1);
});
